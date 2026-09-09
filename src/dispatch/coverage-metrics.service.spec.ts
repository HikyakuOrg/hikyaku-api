import type { DataSource } from 'typeorm';
import {
    CoverageMetricsService,
    summarise,
    type OrgWindow,
} from './coverage-metrics.service';
import type { CoverageOutcome } from './coverage';

/**
 * The counters, with no Sentry and no database.
 *
 * Sentry is replaced wholesale rather than initialised without a DSN, because a
 * no-op SDK records nothing and there would be nothing to assert on. What
 * matters here is not that Sentry received something, it is WHAT it received:
 * one pre-aggregated point per bucket rather than one event per package, and an
 * alert that stays quiet for an organisation which has drawn no territories.
 */
jest.mock('@sentry/nestjs', () => ({
    metrics: { count: jest.fn() },
    captureMessage: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sentry = require('@sentry/nestjs') as {
    metrics: { count: jest.Mock };
    captureMessage: jest.Mock;
};

const ORG = 'org-1';
const NOW = new Date('2026-09-01T09:00:00Z');

/** The one query this service can make: how many territories are drawn. */
function build(liveAreas: number | Error = 0) {
    const query = jest.fn((sql: string) => {
        if (liveAreas instanceof Error) return Promise.reject(liveAreas);
        if (sql.includes('FROM service_areas')) {
            return Promise.resolve([{ count: liveAreas }]);
        }
        return Promise.resolve([]);
    });
    const dataSource = { query } as unknown as DataSource;
    return { service: new CoverageMetricsService(dataSource), query };
}

/** N assignments with the same outcome, which is all most tests need. */
function record(
    service: CoverageMetricsService,
    outcome: CoverageOutcome,
    times: number,
): void {
    for (let i = 0; i < times; i++) service.recordAssignment(ORG, outcome);
}

/** The value of one emitted counter point, or undefined if it was not sent. */
function pointFor(name: string, attributes: Record<string, unknown>): unknown {
    const call = sentry.metrics.count.mock.calls.find(
        ([metric, , options]: [string, number, { attributes: unknown }]) =>
            metric === name &&
            JSON.stringify(options.attributes) === JSON.stringify(attributes),
    ) as [string, number, unknown] | undefined;
    return call?.[1];
}

describe('CoverageMetricsService', () => {
    beforeEach(() => {
        jest.useFakeTimers({
            doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
        }).setSystemTime(NOW);
        sentry.metrics.count.mockClear();
        sentry.captureMessage.mockClear();
    });

    afterEach(() => jest.useRealTimers());

    describe('the assignment counter', () => {
        it('sends one pre-aggregated point per bucket, not one per package', async () => {
            // The cardinality decision, checked. Organisation id is an
            // unbounded attribute and this could not be sized against the
            // Sentry plan from here, so the safe shape is a sum per window.
            const { service } = build();
            record(service, 'covered', 40);
            record(service, 'floater', 2);

            await service.flush();

            expect(sentry.metrics.count).toHaveBeenCalledTimes(2);
            expect(
                pointFor('dispatch.assignment', {
                    organisation: ORG,
                    coverage_outcome: 'covered',
                }),
            ).toBe(40);
            expect(
                pointFor('dispatch.assignment', {
                    organisation: ORG,
                    coverage_outcome: 'floater',
                }),
            ).toBe(2);
        });

        it('says nothing about the buckets that stayed empty', async () => {
            const { service } = build();
            record(service, 'covered', 1);
            await service.flush();
            expect(sentry.metrics.count).toHaveBeenCalledTimes(1);
        });

        it('keeps organisations apart', async () => {
            const { service } = build();
            service.recordAssignment('org-a', 'covered');
            service.recordAssignment('org-b', 'covered');
            service.recordAssignment('org-b', 'covered');

            await service.flush();

            expect(
                pointFor('dispatch.assignment', {
                    organisation: 'org-a',
                    coverage_outcome: 'covered',
                }),
            ).toBe(1);
            expect(
                pointFor('dispatch.assignment', {
                    organisation: 'org-b',
                    coverage_outcome: 'covered',
                }),
            ).toBe(2);
        });

        it('starts a fresh window after a flush, so nothing is double counted', async () => {
            const { service } = build();
            record(service, 'covered', 3);
            await service.flush();
            sentry.metrics.count.mockClear();

            await service.flush();

            expect(sentry.metrics.count).not.toHaveBeenCalled();
        });

        it('flushes on its own once the window is up, with no timer', async () => {
            // A setInterval would be a second scheduled job in a module that
            // deliberately has none, and would keep this process alive.
            const { service } = build();
            record(service, 'covered', 1);
            expect(sentry.metrics.count).not.toHaveBeenCalled();

            jest.setSystemTime(new Date(NOW.getTime() + 61_000));
            service.recordAssignment(ORG, 'covered');
            await Promise.resolve();

            expect(sentry.metrics.count).toHaveBeenCalled();
        });

        it('does not lose the last window on shutdown', async () => {
            const { service } = build();
            record(service, 'covered', 1);
            await service.onModuleDestroy();
            expect(sentry.metrics.count).toHaveBeenCalled();
        });
    });

    describe('the shift-opening counter', () => {
        it('separates the step the feature added from the one that existed', async () => {
            // Step 4 predates service areas. Step 2 is the new billed spend:
            // it opens a shift for a covering driver BEFORE the step that
            // would have used a van that was already out.
            const { service } = build();
            service.recordShiftOpened(ORG, 2);
            service.recordShiftOpened(ORG, 2);
            service.recordShiftOpened(ORG, 4);

            await service.flush();

            expect(
                pointFor('dispatch.shift_opened', {
                    organisation: ORG,
                    step: 2,
                }),
            ).toBe(2);
            expect(
                pointFor('dispatch.shift_opened', {
                    organisation: ORG,
                    step: 4,
                }),
            ).toBe(1);
        });
    });

    describe('the fallback rate alert', () => {
        /** Enough decisions to clear the minimum, at the given fallback rate. */
        const withRate = (
            service: CoverageMetricsService,
            fallbacks: number,
            covered: number,
        ): void => {
            record(service, 'fallback_no_covering_driver', fallbacks);
            record(service, 'covered', covered);
        };

        it('warns when too much traffic leaves the drivers’ areas', async () => {
            const { service } = build(3);
            withRate(service, 10, 20);

            await service.flush();

            expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
            const [message, options] = sentry.captureMessage.mock.calls[0] as [
                string,
                { level: string; tags: Record<string, string> },
            ];
            expect(message).toContain('33%');
            expect(options.level).toBe('warning');
            expect(options.tags.organisation).toBe(ORG);
        });

        it('stays quiet for an organisation that has drawn nothing', async () => {
            // 100% fallback with no territories is correct by construction, not
            // a fault, and paging on it is how people learn to ignore alerts.
            const { service } = build(0);
            withRate(service, 30, 0);

            await service.flush();

            expect(sentry.captureMessage).not.toHaveBeenCalled();
        });

        it('stays quiet below the threshold', async () => {
            const { service } = build(5);
            withRate(service, 1, 99);
            await service.flush();
            expect(sentry.captureMessage).not.toHaveBeenCalled();
        });

        it('stays quiet on too few decisions to have a rate at all', async () => {
            // Three packages, one fallback, 33%: a ratio over a handful of
            // samples says nothing.
            const { service } = build(5);
            withRate(service, 1, 2);
            await service.flush();
            expect(sentry.captureMessage).not.toHaveBeenCalled();
        });

        it('does not ask about territories unless it is about to alert', async () => {
            const { service, query } = build(5);
            record(service, 'covered', 100);
            await service.flush();
            expect(query).not.toHaveBeenCalled();
        });

        it('stays quiet, rather than guessing, when it cannot count territories', async () => {
            const { service } = build(new Error('database asleep'));
            withRate(service, 10, 20);

            await service.flush();

            expect(sentry.captureMessage).not.toHaveBeenCalled();
        });

        it('never lets a metrics failure escape into the assignment path', async () => {
            const { service } = build(3);
            sentry.metrics.count.mockImplementationOnce(() => {
                throw new Error('sentry on fire');
            });
            record(service, 'covered', 1);

            await expect(service.flush()).resolves.toBeUndefined();
        });
    });
});

describe('summarise', () => {
    const window = (
        outcomes: Partial<Record<CoverageOutcome, number>>,
    ): OrgWindow => ({
        outcomes: new Map(
            Object.entries(outcomes) as [CoverageOutcome, number][],
        ),
        shiftsOpened: new Map(),
    });

    it('leaves `disabled` out of the denominator', () => {
        // With the kill switch off no coverage question was asked, so counting
        // those as successful decisions would report a perfect rate for a
        // feature that is not running.
        const summary = summarise(ORG, window({ disabled: 50, covered: 2 }));
        expect(summary.decisions).toBe(2);
        expect(summary.fallbacks).toBe(0);
        expect(summary.outcomes.disabled).toBe(50);
    });

    it('counts both kinds of fallback against the rate', () => {
        const summary = summarise(
            ORG,
            window({
                covered: 6,
                floater: 2,
                fallback_no_covering_capacity: 1,
                fallback_no_covering_driver: 1,
            }),
        );
        expect(summary.decisions).toBe(10);
        expect(summary.fallbacks).toBe(2);
    });

    it('counts a floater match as a decision that reached a covering driver', () => {
        const summary = summarise(ORG, window({ floater: 4 }));
        expect(summary.decisions).toBe(4);
        expect(summary.fallbacks).toBe(0);
    });

    it('reports every bucket, zeros included, so a gap is not a missing key', () => {
        const summary = summarise(ORG, window({}));
        expect(summary.outcomes).toEqual({
            covered: 0,
            floater: 0,
            fallback_no_covering_capacity: 0,
            fallback_no_covering_driver: 0,
            disabled: 0,
        });
        expect(summary.decisions).toBe(0);
    });
});
