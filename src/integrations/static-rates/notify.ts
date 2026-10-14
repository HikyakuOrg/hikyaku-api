/**
 * Wakes StaticRatesPushService for a change the database can't see: catalog
 * edits, which live in Stripe. Plain function, no Nest module, so the
 * services and payments modules can call it without importing integrations.
 */

/** Channel the static_rates_changed triggers notify on. */
export const STATIC_RATES_CHANNEL = 'hikyaku_static_rates';

export interface NotifyExecutor {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export async function notifyStaticRatesChanged(
    executor: NotifyExecutor,
    organisationId: string,
    reason: string,
): Promise<void> {
    await executor.query(`SELECT pg_notify($1, $2)`, [
        STATIC_RATES_CHANNEL,
        `${organisationId}|${reason}`,
    ]);
}
