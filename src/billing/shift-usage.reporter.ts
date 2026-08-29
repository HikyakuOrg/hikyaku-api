import { createHash } from 'crypto';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PgNotifyService } from 'src/dispatch/pg-notify.service';
import { BillingService } from './billing.service';

/** The channel log_shift_usage_event() notifies from inside the shift insert. */
export const SHIFT_USAGE_CHANNEL = 'hikyaku_shift_usage';

/**
 * Coalescing window.
 *
 * Ten seconds rather than the notify default: a 200-package import can open
 * several shifts in a second, and Stripe would rather have one meter event per
 * organisation than one per shift.
 */
const DEBOUNCE_MS = 10_000;

/**
 * How long a claim may sit unreported before another reporter may take it.
 *
 * A reporter that dies between claiming and reporting would otherwise hold those
 * rows forever. Five minutes is far longer than the Stripe call takes and far
 * shorter than anyone would notice the delay.
 */
const STALE_CLAIM_MINUTES = 5;

interface ClaimedRow {
    id: string;
    organisation_id: string;
}

/**
 * Drains stripe.shift_usage_events into Stripe Billing Meters.
 *
 * Replaces BillingService's @Cron(EVERY_MINUTE), and fixes a live billing bug
 * while it is at it. The cron read `WHERE reported_at IS NULL`, posted to Stripe,
 * then marked the rows reported — with nothing in between. Two replicas ticking
 * in the same minute both read the same rows and both reported them, so every
 * shift was billed once per running replica.
 *
 * The fix is a claim step. The UPDATE ... RETURNING is atomic, so exactly one
 * reporter walks away with any given row, and only the ids that came back are
 * reported. A crash between claiming and reporting delays a meter event by five
 * minutes instead of losing it.
 *
 * Woken by NOTIFY rather than polled: log_shift_usage_event() already runs inside
 * the shift insert, so it can ring the bell itself.
 */
@Injectable()
export class ShiftUsageReporter implements OnApplicationBootstrap {
    private readonly logger = new Logger(ShiftUsageReporter.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly notify: PgNotifyService,
        private readonly billing: BillingService,
    ) { }

    onApplicationBootstrap(): void {
        this.notify.subscribe({
            channel: SHIFT_USAGE_CHANNEL,
            debounceMs: DEBOUNCE_MS,
            // The payload names an organisation, but the drain is global: a wake
            // for one org is as good a moment as any to report every org with
            // outstanding rows, and it means a notification lost to a reconnect
            // costs nothing.
            onWake: () => this.drain(),
        });
    }

    /**
     * Claims whatever is outstanding, reports it, and marks it done.
     *
     * A failure for one organisation — an archived price, a Stripe outage — is
     * logged and its claim is released, so the next drain retries it rather than
     * the whole batch being abandoned.
     */
    async drain(): Promise<void> {
        const claimed = await this.claim();
        if (claimed.length === 0) return;

        const byOrg = new Map<string, string[]>();
        for (const row of claimed) {
            const ids = byOrg.get(row.organisation_id) ?? [];
            ids.push(String(row.id));
            byOrg.set(row.organisation_id, ids);
        }

        for (const [organisationId, ids] of byOrg) {
            try {
                await this.billing.reportShiftUsageBatch(
                    organisationId,
                    ids.length,
                    this.identifierFor(ids),
                );
                await this.markReported(ids);
                this.logger.log(
                    `Reported ${ids.length} shift(s) for org ${organisationId}.`,
                );
            } catch (err: unknown) {
                this.logger.error(
                    `Failed to report ${ids.length} shift(s) for org ${organisationId}: ${String(err)}`,
                );
                await this.releaseClaim(ids);
            }
        }
    }

    /**
     * Takes ownership of the unreported rows.
     *
     * This is the statement the cron did not have. UPDATE ... RETURNING is
     * atomic: two replicas racing here get disjoint sets, and whichever loses a
     * given row simply does not see it.
     *
     * Goes through a QueryRunner because TypeORM resolves an UPDATE to
     * [rows, rowCount] on DataSource.query, so RETURNING rows are unreachable
     * there — only QueryRunner.query takes the flag that yields them.
     */
    private async claim(): Promise<ClaimedRow[]> {
        const runner = this.dataSource.createQueryRunner();
        try {
            const result = await runner.query(
                `UPDATE stripe.shift_usage_events
                    SET reporting_started_at = now()
                  WHERE reported_at IS NULL
                    AND (reporting_started_at IS NULL
                         OR reporting_started_at < now() - make_interval(mins => $1::int))
                RETURNING id, organisation_id`,
                [STALE_CLAIM_MINUTES],
                true,
            );
            return (result.records ?? []) as ClaimedRow[];
        } catch (err: unknown) {
            this.logger.error(`Could not claim shift usage events: ${String(err)}`);
            return [];
        } finally {
            await runner.release();
        }
    }

    private async markReported(ids: string[]): Promise<void> {
        await this.dataSource.query(
            `UPDATE stripe.shift_usage_events
                SET reported_at = now()
              WHERE id = ANY($1::bigint[])`,
            [ids],
        );
    }

    /** Hands the rows back so the next drain can pick them up immediately. */
    private async releaseClaim(ids: string[]): Promise<void> {
        await this.dataSource
            .query(
                `UPDATE stripe.shift_usage_events
                    SET reporting_started_at = NULL
                  WHERE id = ANY($1::bigint[]) AND reported_at IS NULL`,
                [ids],
            )
            .catch(() => undefined);
    }

    /**
     * A deterministic name for this batch, so Stripe deduplicates it too.
     *
     * Belt and braces on top of the claim: if a reporter posts successfully and
     * then dies before marking the rows reported, the stale-claim recovery will
     * re-report the same id set — and Stripe recognises the identifier and counts
     * it once.
     */
    private identifierFor(ids: string[]): string {
        const digest = createHash('sha256')
            .update([...ids].sort().join(','))
            .digest('hex');
        return `shift_usage_${digest.slice(0, 48)}`;
    }
}
