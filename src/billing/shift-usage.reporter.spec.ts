import { NotFoundException } from '@nestjs/common';
import {
    ShiftUsageReporter,
    SHIFT_USAGE_CHANNEL,
} from './shift-usage.reporter';

interface State {
    /** Rows the claim UPDATE ... RETURNING hands back. */
    claimed?: { id: string; organisation_id: string }[];
    claimError?: Error;
}

function build(state: State = {}) {
    const log: { sql: string; params: unknown[] }[] = [];

    const runnerQuery = jest.fn(
        (sql: string, params: unknown[] = [], structured?: boolean) => {
            log.push({ sql, params });
            if (state.claimError) return Promise.reject(state.claimError);
            const rows = state.claimed ?? [
                { id: '1', organisation_id: 'org-1' },
            ];
            return Promise.resolve(structured ? { records: rows } : rows);
        },
    );
    const runner = {
        query: runnerQuery,
        release: jest.fn().mockResolvedValue(undefined),
    };

    const query = jest.fn((sql: string, params: unknown[] = []) => {
        log.push({ sql, params });
        return Promise.resolve([]);
    });
    const dataSource = { query, createQueryRunner: jest.fn(() => runner) };

    const notify = { subscribe: jest.fn() };
    const billing = {
        reportShiftUsageBatch: jest.fn().mockResolvedValue(undefined),
    };

    const reporter = new ShiftUsageReporter(
        dataSource as never,
        notify as never,
        billing as never,
    );
    return { reporter, notify, billing, runner, log };
}

describe('ShiftUsageReporter', () => {
    it('is woken by NOTIFY rather than polled, with a ten-second window', () => {
        // A 200-package import can open several shifts in a second; Stripe would
        // rather have one meter event per organisation than one per shift.
        const { reporter, notify } = build();
        reporter.onApplicationBootstrap();

        expect(notify.subscribe).toHaveBeenCalledWith(
            expect.objectContaining({
                channel: SHIFT_USAGE_CHANNEL,
                debounceMs: 10_000,
            }),
        );
    });

    it('drains when the subscription fires', async () => {
        const { reporter, notify, billing } = build();
        reporter.onApplicationBootstrap();

        await notify.subscribe.mock.calls[0][0].onWake(['org-1']);
        expect(billing.reportShiftUsageBatch).toHaveBeenCalled();
    });

    describe('the claim', () => {
        it('takes the rows before anything is reported', async () => {
            // This statement is the fix. The cron had no claim step at all, so
            // two replicas ticking in the same minute both read the same rows and
            // both billed them.
            const { reporter, log } = build();
            await reporter.drain();

            const claim = log[0];
            expect(claim.sql).toContain('UPDATE stripe.shift_usage_events');
            expect(claim.sql).toContain('reporting_started_at = now()');
            expect(claim.sql).toContain('RETURNING id, organisation_id');
        });

        it('asks for RETURNING rows through a runner, not the pool', async () => {
            // TypeORM resolves an UPDATE to [rows, rowCount] on DataSource.query,
            // so RETURNING rows are unreachable there.
            const { reporter, runner } = build();
            await reporter.drain();
            expect(runner.query.mock.calls[0][2]).toBe(true);
            expect(runner.release).toHaveBeenCalled();
        });

        it('lets a claim older than five minutes be taken again', async () => {
            // A reporter that died between claiming and reporting must not hold
            // those rows forever.
            const { reporter, log } = build();
            await reporter.drain();
            expect(log[0].sql).toContain('reporting_started_at IS NULL');
            expect(log[0].sql).toContain('make_interval(mins => $1::int)');
            expect(log[0].params).toEqual([5]);
        });

        it('reports nothing when it claimed nothing', async () => {
            const { reporter, billing } = build({ claimed: [] });
            await reporter.drain();
            expect(billing.reportShiftUsageBatch).not.toHaveBeenCalled();
        });

        it('survives a database that will not answer', async () => {
            const { reporter, billing } = build({
                claimError: new Error('connection reset'),
            });
            await expect(reporter.drain()).resolves.toBeUndefined();
            expect(billing.reportShiftUsageBatch).not.toHaveBeenCalled();
        });
    });

    describe('reporting', () => {
        it('reports only the rows it actually claimed', async () => {
            const { reporter, billing } = build({
                claimed: [
                    { id: '1', organisation_id: 'org-1' },
                    { id: '2', organisation_id: 'org-1' },
                    { id: '3', organisation_id: 'org-1' },
                ],
            });
            await reporter.drain();

            expect(billing.reportShiftUsageBatch).toHaveBeenCalledWith(
                'org-1',
                3,
                expect.any(String),
            );
        });

        it('sends one meter event per organisation, not per shift', async () => {
            const { reporter, billing } = build({
                claimed: [
                    { id: '1', organisation_id: 'org-1' },
                    { id: '2', organisation_id: 'org-2' },
                    { id: '3', organisation_id: 'org-1' },
                ],
            });
            await reporter.drain();

            expect(billing.reportShiftUsageBatch).toHaveBeenCalledTimes(2);
            expect(billing.reportShiftUsageBatch).toHaveBeenCalledWith(
                'org-1',
                2,
                expect.any(String),
            );
            expect(billing.reportShiftUsageBatch).toHaveBeenCalledWith(
                'org-2',
                1,
                expect.any(String),
            );
        });

        it('gives Stripe a deterministic identifier for the batch', async () => {
            // Belt and braces on the claim: if a reporter posts and then dies
            // before marking the rows reported, the stale-claim recovery reposts
            // the same set and Stripe counts it once.
            const first = build({
                claimed: [
                    { id: '2', organisation_id: 'org-1' },
                    { id: '1', organisation_id: 'org-1' },
                ],
            });
            await first.reporter.drain();

            const second = build({
                claimed: [
                    { id: '1', organisation_id: 'org-1' },
                    { id: '2', organisation_id: 'org-1' },
                ],
            });
            await second.reporter.drain();

            expect(first.billing.reportShiftUsageBatch.mock.calls[0][2]).toBe(
                second.billing.reportShiftUsageBatch.mock.calls[0][2],
            );
        });

        it('marks the batch reported once Stripe has it', async () => {
            const { reporter, log } = build({
                claimed: [{ id: '7', organisation_id: 'org-1' }],
            });
            await reporter.drain();

            const done = log.find((q) => q.sql.includes('reported_at = now()'));
            expect(done?.params).toEqual([['7']]);
        });

        it('marks nothing reported when Stripe rejected it', async () => {
            const { reporter, billing, log } = build();
            billing.reportShiftUsageBatch.mockRejectedValue(
                new NotFoundException('price archived'),
            );
            await reporter.drain();

            expect(log.some((q) => q.sql.includes('reported_at = now()'))).toBe(
                false,
            );
        });

        it('releases a failed claim so the next drain retries it', async () => {
            const { reporter, billing, log } = build({
                claimed: [{ id: '7', organisation_id: 'org-1' }],
            });
            billing.reportShiftUsageBatch.mockRejectedValue(
                new Error('stripe down'),
            );
            await reporter.drain();

            const release = log.find((q) =>
                q.sql.includes('reporting_started_at = NULL'),
            );
            expect(release?.params).toEqual([['7']]);
        });

        it('does not let one broken organisation abort the rest', async () => {
            const { reporter, billing } = build({
                claimed: [
                    { id: '1', organisation_id: 'org-broken' },
                    { id: '2', organisation_id: 'org-1' },
                ],
            });
            billing.reportShiftUsageBatch.mockImplementation((orgId: string) =>
                orgId === 'org-broken'
                    ? Promise.reject(
                          new NotFoundException('Organisation not found'),
                      )
                    : Promise.resolve(),
            );

            await expect(reporter.drain()).resolves.toBeUndefined();
            expect(billing.reportShiftUsageBatch).toHaveBeenCalledTimes(2);
        });
    });
});
