import { createHmac } from 'crypto';
import {
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PgNotifyService } from 'src/dispatch/pg-notify.service';
import { STATIC_RATES_CHANNEL } from './notify';

/** A burst of edits inside this window becomes one push per shop. */
const DEBOUNCE_MS = 15_000;

/** Waits before each retry of a push the app answered 5xx or never got. */
const RETRY_DELAYS_MS = [5_000, 30_000];

const PUSH_TIMEOUT_MS = 10_000;

/** One parsed notification. */
export interface StaticRatesChange {
    organisationId: string;
    reason: string;
    /** Set when the change concerns one shop only. */
    shop?: { platform: string; shopDomain: string };
}

/** `<org>|<reason>[|<platform>|<shop>]`, or null for anything else. */
export function parseChange(payload: string): StaticRatesChange | null {
    const [organisationId, reason, platform, shopDomain] = payload.split('|');
    if (!organisationId || !reason) return null;
    return {
        organisationId,
        reason,
        ...(platform && shopDomain ? { shop: { platform, shopDomain } } : {}),
    };
}

/** The headers that sign a push: HMAC-SHA256 over "<timestamp>.<body>". */
export function signPush(
    secret: string,
    body: string,
    timestamp: number,
): Record<string, string> {
    const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
    return {
        'Content-Type': 'application/json',
        'X-Hikyaku-Timestamp': String(timestamp),
        'X-Hikyaku-Signature': `sha256=${signature}`,
    };
}

interface ShopRow {
    organisation_id: string;
    platform: string;
    shop_domain: string;
}

/**
 * Pushes "resync your static rates" to the storefront app when a shop's band
 * plan or coverage may have changed. Changes arrive as NOTIFYs from the
 * static_rates_changed triggers (and from catalog edits, see
 * notifyStaticRatesChanged); only shops with rates on and the static path
 * are pushed. Best effort: a push lost to a restart is caught by the app's
 * own resync on load.
 *
 * Only Shopify has a static path today, so only HIKYAKU_SHOPIFY_PUSH_URL is
 * read. Without it, or without HIKYAKU_SHOPIFY_PUSH_SECRET, nothing is sent.
 */
@Injectable()
export class StaticRatesPushService
    implements OnApplicationBootstrap, OnModuleDestroy
{
    private readonly logger = new Logger(StaticRatesPushService.name);
    private readonly retries = new Set<NodeJS.Timeout>();

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly notify: PgNotifyService,
    ) {}

    onApplicationBootstrap(): void {
        this.notify.subscribe({
            channel: STATIC_RATES_CHANNEL,
            debounceMs: DEBOUNCE_MS,
            // An empty list follows a reconnect. Pushing every static shop
            // then would rewrite them all on each deploy, so it is skipped.
            onWake: (payloads) => this.handle(payloads),
        });
    }

    onModuleDestroy(): void {
        for (const timer of this.retries) clearTimeout(timer);
        this.retries.clear();
    }

    /** One coalesced window: one push per affected static shop. */
    async handle(payloads: readonly string[]): Promise<void> {
        const changes = payloads
            .map(parseChange)
            .filter((c): c is StaticRatesChange => c !== null);
        if (changes.length === 0) return;

        const shops = await this.staticShops([
            ...new Set(changes.map((c) => c.organisationId)),
        ]);
        for (const shop of shops) {
            const reasons = [
                ...new Set(
                    changes
                        .filter(
                            (c) =>
                                c.organisationId === shop.organisation_id &&
                                (!c.shop ||
                                    (c.shop.platform === shop.platform &&
                                        c.shop.shopDomain ===
                                            shop.shop_domain)),
                        )
                        .map((c) => c.reason),
                ),
            ].sort();
            if (reasons.length > 0) {
                await this.push(shop.platform, shop.shop_domain, reasons, 0);
            }
        }
    }

    private async staticShops(organisationIds: string[]): Promise<ShopRow[]> {
        return this.dataSource.query(
            `SELECT organisation_id, platform, shop_domain
               FROM public.integration_shipping_rate_settings
              WHERE organisation_id = ANY($1::uuid[])
                AND enabled AND path = 'static'
              ORDER BY platform, shop_domain`,
            [organisationIds],
        );
    }

    private async push(
        platform: string,
        shopDomain: string,
        reasons: string[],
        attempt: number,
    ): Promise<void> {
        const url = process.env.HIKYAKU_SHOPIFY_PUSH_URL;
        const secret = process.env.HIKYAKU_SHOPIFY_PUSH_SECRET;
        if (platform !== 'shopify' || !url || !secret) {
            this.logger.debug(
                `Not pushing ${platform}/${shopDomain}: no push URL or secret for the platform.`,
            );
            return;
        }

        const body = JSON.stringify({
            platform,
            shop_domain: shopDomain,
            reasons,
        });
        let retry = false;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: signPush(secret, body, Math.floor(Date.now() / 1000)),
                body,
                signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
            });
            retry = res.status >= 500;
            if (!res.ok) {
                this.logger.warn(
                    `Static rate push for ${shopDomain} got ${res.status}.`,
                );
            }
        } catch (err) {
            retry = true;
            this.logger.warn(
                `Static rate push for ${shopDomain} failed: ${String(err)}`,
            );
        }

        const delay = RETRY_DELAYS_MS[attempt];
        if (retry && delay !== undefined) {
            const timer = setTimeout(() => {
                this.retries.delete(timer);
                void this.push(platform, shopDomain, reasons, attempt + 1);
            }, delay);
            this.retries.add(timer);
        }
    }
}
