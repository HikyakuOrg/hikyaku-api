import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { toStripeMinorUnits } from 'src/common/money';
import { Service } from './entities/service.entity';
import { ServiceAddon } from './entities/service-addon.entity';
import { CreateServiceDto } from './dto/create-service.dto';
import { CreateAddonDto } from './dto/create-addon.dto';

/** A single live price + product fetched from the connected account. */
export interface LivePrice {
    name: string;
    amountMinor: number;
    currency: string;
    /** Stripe `created` epoch — used to order the catalog. */
    created: number;
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

/** Read the (possibly expanded) product name off a Stripe price. */
function priceProductName(price: { product?: unknown }): string {
    const product = price.product;
    if (product && typeof product === 'object' && 'name' in product) {
        const name = (product as { name?: unknown }).name;
        return typeof name === 'string' ? name : '';
    }
    return '';
}

@Injectable()
export class ServicesService {
    private readonly logger = new Logger(ServicesService.name);

    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        @InjectRepository(Service)
        private readonly serviceRepo: Repository<Service>,
        @InjectRepository(ServiceAddon)
        private readonly addonRepo: Repository<ServiceAddon>,
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
     * currency (lowercased, Stripe-style). Checked live on every write so a
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

        const product = await this.stripe.products.create(
            { name: dto.name },
            { stripeAccount },
        );
        const price = await this.stripe.prices.create(
            { product: product.id, unit_amount: unitAmount, currency },
            { stripeAccount, idempotencyKey: `service-price:${product.id}` },
        );

        const row = this.serviceRepo.create({
            organisationId,
            stripeProductId: product.id,
            stripePriceId: price.id,
            pricingUnit: dto.pricingUnit,
        });
        await this.serviceRepo.save(row);
        return { id: row.id };
    }

    async deleteService(organisationId: string, id: string): Promise<void> {
        const service = await this.serviceRepo.findOne({
            where: { id, organisationId },
            relations: ['addons'],
        });
        if (!service) throw new NotFoundException('Service not found');

        const stripeAccount = (await this.orgs.getStripeAccount(organisationId))
            ?.stripeAccountId;
        if (stripeAccount) {
            for (const item of [...(service.addons ?? []), service]) {
                await this.archive(
                    stripeAccount,
                    item.stripeProductId,
                    item.stripePriceId,
                );
            }
        }
        // FK cascade removes the add-on rows.
        await this.serviceRepo.remove(service);
    }

    async createAddon(
        organisationId: string,
        serviceId: string,
        dto: CreateAddonDto,
    ): Promise<{ id: string }> {
        const service = await this.serviceRepo.findOne({
            where: { id: serviceId, organisationId },
        });
        if (!service) throw new NotFoundException('Service not found');

        const stripeAccount = await this.requireConnectedAccount(organisationId);
        // Inherit the parent service's currency (read live from its Stripe price).
        const servicePrice = await this.stripe.prices.retrieve(
            service.stripePriceId,
            undefined,
            { stripeAccount },
        );
        const currency = servicePrice.currency;
        const unitAmount = toStripeMinorUnits(dto.amountMajor, currency);

        const product = await this.stripe.products.create(
            { name: dto.name },
            { stripeAccount },
        );
        const price = await this.stripe.prices.create(
            { product: product.id, unit_amount: unitAmount, currency },
            { stripeAccount, idempotencyKey: `addon-price:${product.id}` },
        );

        const row = this.addonRepo.create({
            serviceId,
            stripeProductId: product.id,
            stripePriceId: price.id,
            pricingUnit: dto.pricingUnit,
        });
        await this.addonRepo.save(row);
        return { id: row.id };
    }

    async deleteAddon(organisationId: string, addonId: string): Promise<void> {
        const addon = await this.addonRepo.findOne({
            where: { id: addonId },
            relations: ['service'],
        });
        if (!addon || addon.service.organisationId !== organisationId) {
            throw new NotFoundException('Add-on not found');
        }

        const stripeAccount = (await this.orgs.getStripeAccount(organisationId))
            ?.stripeAccountId;
        if (stripeAccount) {
            await this.archive(
                stripeAccount,
                addon.stripeProductId,
                addon.stripePriceId,
            );
        }
        await this.addonRepo.remove(addon);
    }

    // ── Catalog (read) ────────────────────────────────────────────────────────

    /**
     * The org's catalog with prices read LIVE from Stripe (one batched list call,
     * not N retrieves). `name`, `amount_minor` and `currency` all come from
     * Stripe; only ids + pricing_unit are local. Returns `{ services: [] }` when
     * the org has no connected account.
     */
    async getCatalog(organisationId: string): Promise<CatalogResponse> {
        const stripeAccount = (await this.orgs.getStripeAccount(organisationId))
            ?.stripeAccountId;
        if (!stripeAccount) return { services: [] };

        const services = await this.serviceRepo.find({
            where: { organisationId },
            relations: ['addons'],
        });
        if (services.length === 0) return { services: [] };

        const priceMap = await this.fetchActivePriceMap(stripeAccount);

        const withCreated = services
            .map((service) => {
                const sp = priceMap.get(service.stripePriceId);
                if (!sp) return null;
                const addons = (service.addons ?? [])
                    .map((addon) => {
                        const ap = priceMap.get(addon.stripePriceId);
                        if (!ap) return null;
                        return {
                            created: ap.created,
                            value: {
                                id: addon.id,
                                name: ap.name,
                                pricing_unit: addon.pricingUnit,
                                amount_minor: ap.amountMinor,
                                currency: ap.currency,
                            },
                        };
                    })
                    .filter((a): a is NonNullable<typeof a> => a !== null)
                    .sort((a, b) => a.created - b.created)
                    .map((a) => a.value);
                return {
                    created: sp.created,
                    value: {
                        id: service.id,
                        name: sp.name,
                        pricing_unit: service.pricingUnit,
                        amount_minor: sp.amountMinor,
                        currency: sp.currency,
                        addons,
                    },
                };
            })
            .filter((s): s is NonNullable<typeof s> => s !== null)
            .sort((a, b) => a.created - b.created)
            .map((s) => s.value);

        return { services: withCreated };
    }

    /**
     * All active prices on the connected account, mapped by price id, with their
     * product name expanded. One call (limit 100) — reused by catalog + booking.
     */
    async fetchActivePriceMap(
        stripeAccount: string,
    ): Promise<Map<string, LivePrice>> {
        const prices = await this.stripe.prices.list(
            { active: true, limit: 100, expand: ['data.product'] },
            { stripeAccount },
        );
        const map = new Map<string, LivePrice>();
        for (const price of prices.data) {
            map.set(price.id, {
                name: priceProductName(price),
                amountMinor: price.unit_amount ?? 0,
                currency: price.currency,
                created: price.created,
            });
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
