import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { toStripeMinorUnits } from 'src/common/money';
import { CreateServiceDto } from './dto/create-service.dto';
import { CreateAddonDto } from './dto/create-addon.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { UpdateAddonDto } from './dto/update-addon.dto';

// Stripe param/return types are derived from the client methods rather than the
// `Stripe.*` namespace, which doesn't resolve cleanly under `module: nodenext`
// (see stripe.provider.ts).
type ProductUpdateParams = NonNullable<
    Parameters<StripeClient['products']['update']>[1]
>;

/** The product fields we read off a Stripe product (expanded default price). */
interface RawProduct {
    id: string;
    name: string;
    created: number;
    metadata: Record<string, string> | null;
    default_price?:
        | string
        | {
              id: string;
              unit_amount: number | null;
              currency: string;
              active: boolean;
          }
        | null;
}

/**
 * A catalog item resolved entirely from Stripe — no DB row. The Stripe product is
 * the source of truth: `pricing_unit`, `kind` (service|addon) and an addon's
 * `parent` product id live in product `metadata`; price/currency come from the
 * product's `default_price`. The product id is the stable public identifier.
 */
export interface CatalogProduct {
    productId: string;
    name: string;
    amountMinor: number;
    currency: string;
    /** Stripe `created` epoch — used to order the catalog. */
    created: number;
    pricingUnit: string;
    kind: 'service' | 'addon';
    /** Parent service's product id (addons only). */
    parentProductId: string | null;
    defaultPriceId: string;
}

export interface CatalogAddon {
    id: string;
    name: string;
    pricing_unit: string;
    amount_minor: number;
    currency: string;
}

export interface CatalogService extends CatalogAddon {
    addons: CatalogAddon[];
}

export interface CatalogResponse {
    services: CatalogService[];
}

/** Project a Stripe product into a {@link CatalogProduct}, or null if it isn't a
 *  catalog item (missing/foreign `kind`, or no active default price). */
function readProduct(product: RawProduct): CatalogProduct | null {
    const kind = product.metadata?.kind;
    if (kind !== 'service' && kind !== 'addon') return null;
    const price = product.default_price;
    if (!price || typeof price === 'string' || !price.active) return null;
    return {
        productId: product.id,
        name: product.name,
        amountMinor: price.unit_amount ?? 0,
        currency: price.currency,
        created: product.created,
        pricingUnit: product.metadata?.pricing_unit ?? 'per_delivery',
        kind,
        parentProductId:
            kind === 'addon' ? (product.metadata?.parent ?? null) : null,
        defaultPriceId: price.id,
    };
}

@Injectable()
export class ServicesService {
    private readonly logger = new Logger(ServicesService.name);

    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        private readonly orgs: OrganisationsService,
    ) {}

    // ── Stripe account guards (shared with the booking service) ─────────────────

    /** Connected-account id for the org, or 400 if Connect onboarding hasn't run. */
    async requireConnectedAccount(organisationId: string): Promise<string> {
        const account = await this.orgs.getStripeAccount(organisationId);
        if (!account?.stripeAccountId) {
            throw new BadRequestException(
                'This organisation has not finished payment setup yet.',
            );
        }
        return account.stripeAccountId;
    }

    /**
     * Assert the connected account can accept payments and return its default
     * currency (lowercased, Stripe-style). Checked live on every create so a
     * service is never created on an account that can't be charged.
     */
    async requireChargesEnabled(stripeAccountId: string): Promise<string> {
        const account = await this.stripe.accounts.retrieve(stripeAccountId);
        if (!account.charges_enabled) {
            throw new BadRequestException(
                'This organisation cannot accept payments yet. Finish Stripe onboarding first.',
            );
        }
        return (account.default_currency ?? 'usd').toLowerCase();
    }

    // ── Admin CRUD ──────────────────────────────────────────────────────────────

    async createService(
        organisationId: string,
        dto: CreateServiceDto,
    ): Promise<{ id: string }> {
        const stripeAccount = await this.requireConnectedAccount(organisationId);
        const accountCurrency = await this.requireChargesEnabled(stripeAccount);
        const currency = (dto.currency ?? accountCurrency).toLowerCase();
        const unitAmount = toStripeMinorUnits(dto.amountMajor, currency);

        // Product + its default price in one call; metadata carries everything we
        // used to keep in the DB row.
        const product = await this.stripe.products.create(
            {
                name: dto.name,
                metadata: { kind: 'service', pricing_unit: dto.pricingUnit },
                default_price_data: { unit_amount: unitAmount, currency },
            },
            { stripeAccount },
        );
        return { id: product.id };
    }

    async createAddon(
        organisationId: string,
        serviceProductId: string,
        dto: CreateAddonDto,
    ): Promise<{ id: string }> {
        const stripeAccount = await this.requireConnectedAccount(organisationId);
        const map = await this.fetchActiveProductMap(stripeAccount);
        const parent = map.get(serviceProductId);
        if (!parent || parent.kind !== 'service') {
            throw new NotFoundException('Service not found');
        }
        // Inherit the parent service's currency.
        const currency = parent.currency;
        const unitAmount = toStripeMinorUnits(dto.amountMajor, currency);

        const product = await this.stripe.products.create(
            {
                name: dto.name,
                metadata: {
                    kind: 'addon',
                    pricing_unit: dto.pricingUnit,
                    parent: serviceProductId,
                },
                default_price_data: { unit_amount: unitAmount, currency },
            },
            { stripeAccount },
        );
        return { id: product.id };
    }

    async updateService(
        organisationId: string,
        productId: string,
        dto: UpdateServiceDto,
    ): Promise<{ id: string }> {
        const stripeAccount = await this.requireConnectedAccount(organisationId);
        const map = await this.fetchActiveProductMap(stripeAccount);
        const product = map.get(productId);
        if (!product || product.kind !== 'service') {
            throw new NotFoundException('Service not found');
        }
        await this.applyProductUpdate(stripeAccount, product, dto);
        return { id: product.productId };
    }

    async updateAddon(
        organisationId: string,
        productId: string,
        dto: UpdateAddonDto,
    ): Promise<{ id: string }> {
        const stripeAccount = await this.requireConnectedAccount(organisationId);
        const map = await this.fetchActiveProductMap(stripeAccount);
        const product = map.get(productId);
        if (!product || product.kind !== 'addon') {
            throw new NotFoundException('Add-on not found');
        }
        await this.applyProductUpdate(stripeAccount, product, dto);
        return { id: product.productId };
    }

    async deleteService(organisationId: string, productId: string): Promise<void> {
        const stripeAccount = (await this.orgs.getStripeAccount(organisationId))
            ?.stripeAccountId;
        if (!stripeAccount) throw new NotFoundException('Service not found');

        const map = await this.fetchActiveProductMap(stripeAccount);
        const service = map.get(productId);
        if (!service || service.kind !== 'service') {
            throw new NotFoundException('Service not found');
        }
        // Archive child addons first (replaces the old FK cascade), then the service.
        for (const item of map.values()) {
            if (item.kind === 'addon' && item.parentProductId === productId) {
                await this.archive(stripeAccount, item.productId, item.defaultPriceId);
            }
        }
        await this.archive(stripeAccount, service.productId, service.defaultPriceId);
    }

    async deleteAddon(organisationId: string, productId: string): Promise<void> {
        const stripeAccount = (await this.orgs.getStripeAccount(organisationId))
            ?.stripeAccountId;
        if (!stripeAccount) throw new NotFoundException('Add-on not found');

        const map = await this.fetchActiveProductMap(stripeAccount);
        const addon = map.get(productId);
        if (!addon || addon.kind !== 'addon') {
            throw new NotFoundException('Add-on not found');
        }
        await this.archive(stripeAccount, addon.productId, addon.defaultPriceId);
    }

    /**
     * Apply the supplied (partial) edits to a catalog product. Name and
     * `pricing_unit` are patched in place; Stripe merges metadata keys, so `kind`
     * and `parent` are preserved. A price change creates a new price, points the
     * product's `default_price` at it, and archives the old one (the product id —
     * the public handle — is unchanged). Currency is not editable.
     */
    private async applyProductUpdate(
        stripeAccount: string,
        product: CatalogProduct,
        dto: { name?: string; pricingUnit?: string; amountMajor?: number },
    ): Promise<void> {
        const productUpdate: ProductUpdateParams = {};
        if (dto.name !== undefined) productUpdate.name = dto.name;
        if (dto.pricingUnit !== undefined) {
            productUpdate.metadata = { pricing_unit: dto.pricingUnit };
        }
        if (productUpdate.name !== undefined || productUpdate.metadata !== undefined) {
            await this.stripe.products.update(product.productId, productUpdate, {
                stripeAccount,
            });
        }

        if (dto.amountMajor !== undefined) {
            const unitAmount = toStripeMinorUnits(dto.amountMajor, product.currency);
            const newPrice = await this.stripe.prices.create(
                {
                    product: product.productId,
                    unit_amount: unitAmount,
                    currency: product.currency,
                },
                { stripeAccount },
            );
            await this.stripe.products.update(
                product.productId,
                { default_price: newPrice.id },
                { stripeAccount },
            );
            if (product.defaultPriceId !== newPrice.id) {
                await this.stripe.prices.update(
                    product.defaultPriceId,
                    { active: false },
                    { stripeAccount },
                );
            }
        }
    }

    // ── Catalog (read) ────────────────────────────────────────────────────────

    /**
     * The org's catalog, read entirely from Stripe (one paged product list). The
     * product id is the item id; addons are nested under their parent service via
     * `metadata.parent`. Returns `{ services: [] }` when the org has no connected
     * account.
     */
    async getCatalog(organisationId: string): Promise<CatalogResponse> {
        const stripeAccount = (await this.orgs.getStripeAccount(organisationId))
            ?.stripeAccountId;
        if (!stripeAccount) return { services: [] };

        const map = await this.fetchActiveProductMap(stripeAccount);
        const products = [...map.values()];

        const addonsByParent = new Map<string, CatalogProduct[]>();
        for (const p of products) {
            if (p.kind === 'addon' && p.parentProductId) {
                const list = addonsByParent.get(p.parentProductId) ?? [];
                list.push(p);
                addonsByParent.set(p.parentProductId, list);
            }
        }

        const toAddon = (p: CatalogProduct): CatalogAddon => ({
            id: p.productId,
            name: p.name,
            pricing_unit: p.pricingUnit,
            amount_minor: p.amountMinor,
            currency: p.currency,
        });

        const services = products
            .filter((p) => p.kind === 'service')
            .sort((a, b) => a.created - b.created)
            .map((service) => ({
                ...toAddon(service),
                addons: (addonsByParent.get(service.productId) ?? [])
                    .sort((a, b) => a.created - b.created)
                    .map(toAddon),
            }));

        return { services };
    }

    /**
     * All active catalog products on the connected account, keyed by product id,
     * with their `default_price` expanded. Auto-paginates so catalogs over 100
     * items still resolve fully. Reused by catalog reads + booking.
     */
    async fetchActiveProductMap(
        stripeAccount: string,
    ): Promise<Map<string, CatalogProduct>> {
        const map = new Map<string, CatalogProduct>();
        for await (const product of this.stripe.products.list(
            { active: true, limit: 100, expand: ['data.default_price'] },
            { stripeAccount },
        )) {
            const parsed = readProduct(product);
            if (parsed) map.set(parsed.productId, parsed);
        }
        return map;
    }

    /** Best-effort archive: deactivate the price then the product. Never throws. */
    private async archive(
        stripeAccount: string,
        productId: string,
        priceId: string,
    ): Promise<void> {
        try {
            await this.stripe.prices.update(
                priceId,
                { active: false },
                { stripeAccount },
            );
        } catch (err) {
            this.logger.error(`Failed to archive price ${priceId}: ${String(err)}`);
        }
        try {
            await this.stripe.products.update(
                productId,
                { active: false },
                { stripeAccount },
            );
        } catch (err) {
            this.logger.error(
                `Failed to archive product ${productId}: ${String(err)}`,
            );
        }
    }
}
