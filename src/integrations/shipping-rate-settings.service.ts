import {
    BadRequestException,
    ConflictException,
    Injectable,
    UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { minorToDecimalString } from 'src/common/money';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { ServicesService } from 'src/services/services.service';
import type { CatalogProduct } from 'src/services/services.service';
import { amountFor } from 'src/services/price-amount';
import type {
    BandSettingDto,
    PutShippingRateSettingsDto,
    ShippingRateErrorCode,
    ShippingRatePath,
    ShippingRateServiceDto,
    ShippingRateSettingsDto,
    ShippingRateSettingsViewDto,
} from './dto/shipping-rate-settings.dto';

/** A stored settings row. */
export interface ShippingRateSettingsRow {
    id: string;
    organisation_id: string;
    platform: string;
    shop_domain: string;
    shop_currency: string | null;
    enabled: boolean;
    service_ids: string[];
    path: ShippingRatePath | null;
    band_settings: Record<string, BandSettingDto>;
}

const COLS = `id, organisation_id, platform, shop_domain, shop_currency,
    enabled, service_ids, path, band_settings`;

/** Units the static path splits into bands. */
const BANDED_UNITS = new Set(['per_km', 'per_mi', 'per_kg', 'per_lb']);

/** Defaults for a shop with nothing stored. Never written. */
const DEFAULT_SETTINGS: ShippingRateSettingsDto = {
    enabled: false,
    service_ids: [],
    shop_currency: null,
    path: null,
    band_settings: {},
};

/**
 * Reads and writes `integration_shipping_rate_settings`: which catalog
 * services a storefront shop offers as checkout rates.
 *
 * Runs as service_role, which bypasses RLS, so every organisation-facing
 * query filters on organisation_id. {@link findByShop} is the exception: the
 * carrier callback has only the shop, and the row is how it finds the
 * organisation.
 */
@Injectable()
export class ShippingRateSettingsService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly orgs: OrganisationsService,
        private readonly services: ServicesService,
    ) {}

    /**
     * The settings screen's view: stored settings (or defaults), whether
     * Stripe is connected, and each catalog service with its amount in
     * `currency` (falling back to the stored shop currency).
     */
    async getView(
        organisationId: string,
        userId: string,
        platform: string,
        shopDomain: string,
        currency?: string,
    ): Promise<ShippingRateSettingsViewDto> {
        const row = await this.findOwn(organisationId, platform, shopDomain);
        const settings = row ? toSettingsDto(row) : DEFAULT_SETTINGS;
        const { connected, catalog } = await this.loadCatalog(organisationId);
        const viewCurrency = (
            currency ??
            settings.shop_currency ??
            ''
        ).toUpperCase();

        const services: ShippingRateServiceDto[] = catalog.map((s) => {
            const code = viewCurrency || s.currency.toUpperCase();
            const minor = amountFor(s, code);
            return {
                id: s.productId,
                name: s.name,
                description: s.description,
                unit: s.pricingUnit,
                amount:
                    minor === null ? null : minorToDecimalString(minor, code),
                currency: code,
            };
        });

        return {
            settings,
            stripe_connected: connected,
            services,
            dashboard_service_url: await this.serviceRatesUrl(organisationId),
            can_edit: await this.canEdit(organisationId, userId),
        };
    }

    /** Whether the user may PUT and DELETE, so the app can show view-only. */
    private async canEdit(
        organisationId: string,
        userId: string,
    ): Promise<boolean> {
        const rows: unknown[] = await this.dataSource.query(
            `SELECT 1 FROM public.user_permission up
               JOIN public.app_permission p ON p.id = up.permission_id
              WHERE up.organisation_id = $1 AND up.user_id = $2
                AND p.permission = 'integrations.shipping_rates.write'`,
            [organisationId, userId],
        );
        return rows.length > 0;
    }

    /** The dashboard's service editor for this organisation, or null. */
    private async serviceRatesUrl(
        organisationId: string,
    ): Promise<string | null> {
        const appUrl = process.env.APP_URL?.replace(/\/+$/, '');
        if (!appUrl) return null;
        const org = await this.orgs.findById(organisationId);
        if (!org) return null;
        return `${appUrl}/orgs/${encodeURIComponent(org.slug)}/dashboard/service-rates`;
    }

    /**
     * Validates and stores one shop's settings. Disabling always succeeds
     * (only unknown service ids are refused), so a merchant can turn rates
     * off even after their Stripe account or catalog changed.
     */
    async put(
        organisationId: string,
        userId: string,
        dto: PutShippingRateSettingsDto,
    ): Promise<ShippingRateSettingsDto> {
        const shopDomain = normaliseShopDomain(dto.shop_domain);
        if (shopDomain === '') {
            throw new BadRequestException('shop_domain should not be empty');
        }
        const serviceIds = [...new Set(dto.service_ids)];
        const shopCurrency = dto.shop_currency?.toUpperCase() ?? null;
        const path = dto.path ?? null;

        const { connected, catalog } = await this.loadCatalog(organisationId);
        const byId = new Map(catalog.map((s) => [s.productId, s]));

        const unknown = serviceIds.filter((id) => !byId.has(id));
        if (unknown.length > 0) {
            throw rateError(
                'unknown_service',
                `Not a service in this organisation's catalog: ${unknown.join(', ')}.`,
                unknown,
            );
        }
        const chosen = serviceIds.map((id) => byId.get(id)!);

        if (dto.enabled) {
            if (!connected) {
                throw rateError(
                    'stripe_not_connected',
                    'Connect Stripe in the Hikyaku dashboard before turning on rates.',
                );
            }
            if (catalog.length === 0) {
                throw rateError(
                    'no_services',
                    'Add a service in the Hikyaku dashboard before turning on rates.',
                );
            }
            if (chosen.length === 0) {
                throw rateError(
                    'no_services',
                    'Choose at least one service to offer as a rate.',
                );
            }
            if (!shopCurrency) {
                throw new BadRequestException(
                    'shop_currency is required to turn on rates',
                );
            }
            const missing = chosen.filter(
                (s) => amountFor(s, shopCurrency) === null,
            );
            if (missing.length > 0) {
                throw rateError(
                    'service_missing_currency',
                    `${missing.map((s) => s.name).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no price in ${shopCurrency}. Add one in the Hikyaku dashboard.`,
                    missing.map((s) => s.productId),
                );
            }
        }

        const bandSettings = pickBandSettings(chosen, dto.band_settings ?? {});
        if (dto.enabled && path === 'static') {
            const invalid = chosen.filter(
                (s) =>
                    BANDED_UNITS.has(s.pricingUnit) &&
                    !bandSettings[s.productId],
            );
            if (invalid.length > 0) {
                throw rateError(
                    'band_settings_invalid',
                    `Set a band width and a maximum for ${invalid.map((s) => s.name).join(', ')}.`,
                    invalid.map((s) => s.productId),
                );
            }
        }

        const rows: ShippingRateSettingsRow[] = await this.dataSource.query(
            `INSERT INTO public.integration_shipping_rate_settings AS s
                (organisation_id, platform, shop_domain, shop_currency, enabled,
                 service_ids, path, band_settings, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8::jsonb, $9)
             ON CONFLICT (platform, shop_domain) DO UPDATE SET
                shop_currency = EXCLUDED.shop_currency,
                enabled = EXCLUDED.enabled,
                service_ids = EXCLUDED.service_ids,
                path = EXCLUDED.path,
                band_settings = EXCLUDED.band_settings,
                updated_at = now(),
                updated_by = EXCLUDED.updated_by
              WHERE s.organisation_id = EXCLUDED.organisation_id
             RETURNING ${COLS}`,
            [
                organisationId,
                dto.platform,
                shopDomain,
                shopCurrency,
                dto.enabled,
                serviceIds,
                path,
                JSON.stringify(bandSettings),
                userId,
            ],
        );
        // No row back: the conflict's WHERE refused, so another
        // organisation holds this shop.
        if (!rows[0]) {
            throw new ConflictException(
                'This shop is connected to another Hikyaku organisation. Disconnect it there first.',
            );
        }
        return toSettingsDto(rows[0]);
    }

    /** Deletes one shop's settings. Idempotent. */
    async remove(
        organisationId: string,
        platform: string,
        shopDomain: string,
    ): Promise<void> {
        await this.dataSource.query(
            `DELETE FROM public.integration_shipping_rate_settings
              WHERE organisation_id = $1 AND platform = $2 AND shop_domain = $3`,
            [organisationId, platform, normaliseShopDomain(shopDomain)],
        );
    }

    /**
     * The shop's settings whatever its organisation. Only for callers that
     * have already authenticated the shop itself, such as the carrier
     * callback after HMAC verification.
     */
    async findByShop(
        platform: string,
        shopDomain: string,
    ): Promise<ShippingRateSettingsRow | null> {
        const rows: ShippingRateSettingsRow[] = await this.dataSource.query(
            `SELECT ${COLS} FROM public.integration_shipping_rate_settings
              WHERE platform = $1 AND shop_domain = $2`,
            [platform, normaliseShopDomain(shopDomain)],
        );
        return rows[0] ?? null;
    }

    private async findOwn(
        organisationId: string,
        platform: string,
        shopDomain: string,
    ): Promise<ShippingRateSettingsRow | null> {
        const rows: ShippingRateSettingsRow[] = await this.dataSource.query(
            `SELECT ${COLS} FROM public.integration_shipping_rate_settings
              WHERE organisation_id = $1 AND platform = $2 AND shop_domain = $3`,
            [organisationId, platform, normaliseShopDomain(shopDomain)],
        );
        return rows[0] ?? null;
    }

    /** The org's catalog services, oldest first, or none without Stripe. */
    private async loadCatalog(
        organisationId: string,
    ): Promise<{ connected: boolean; catalog: CatalogProduct[] }> {
        const account = await this.orgs.getStripeAccount(organisationId);
        if (!account?.stripeAccountId) return { connected: false, catalog: [] };
        const map = await this.services.fetchActiveProductMap(
            account.stripeAccountId,
        );
        const catalog = [...map.values()]
            .filter((p) => p.kind === 'service')
            .sort((a, b) => a.created - b.created);
        return { connected: true, catalog };
    }
}

/** Keeps a valid band setting for each chosen banded service, drops the rest. */
function pickBandSettings(
    chosen: CatalogProduct[],
    input: Record<string, BandSettingDto>,
): Record<string, BandSettingDto> {
    const out: Record<string, BandSettingDto> = {};
    for (const s of chosen) {
        if (!BANDED_UNITS.has(s.pricingUnit)) continue;
        const band = input[s.productId] as Partial<BandSettingDto> | undefined;
        const width = Number(band?.band_width);
        const max = Number(band?.max);
        if (
            Number.isFinite(width) &&
            Number.isFinite(max) &&
            width > 0 &&
            max > 0
        ) {
            out[s.productId] = { band_width: width, max };
        }
    }
    return out;
}

function rateError(
    code: ShippingRateErrorCode,
    message: string,
    serviceIds?: string[],
): UnprocessableEntityException {
    return new UnprocessableEntityException({
        statusCode: 422,
        message,
        code,
        ...(serviceIds ? { service_ids: serviceIds } : {}),
    });
}

export function normaliseShopDomain(domain: string): string {
    return domain.trim().toLowerCase();
}

function toSettingsDto(row: ShippingRateSettingsRow): ShippingRateSettingsDto {
    return {
        enabled: row.enabled,
        service_ids: row.service_ids ?? [],
        shop_currency: row.shop_currency,
        path: row.path,
        band_settings: row.band_settings ?? {},
    };
}
