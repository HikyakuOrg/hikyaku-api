import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { toE164OrNull } from 'src/common/phone';
import { CustomersService } from 'src/customers/customers.service';
import { PackagesService } from 'src/packages/packages.service';
import type {
    FulfillmentDeliveryMethod,
    OrderEventDto,
    OrderFulfillmentGroupDto,
} from './dto/order-event.dto';
import {
    OrderGeocoder,
    UngeocodableAddressError,
    type GeocodedPoint,
} from './order-geocoder';

/** The only event type that produces a package. */
const ORDER_PAID = 'order.paid';

/**
 * Parcel size used when the storefront sends none, which is always: no
 * platform we connect to knows a box's dimensions. Only weight feeds the
 * capacity match; length/width/height are stored because package_dimensions
 * requires them.
 */
const DEFAULT_DIMENSIONS_CM = { length: 30, width: 20, height: 15 };

/** Weight used when neither the order nor its line items carry one. */
const DEFAULT_WEIGHT_KG = 1;

/** Fulfillment groups that leave Hikyaku a parcel to deliver. */
const DELIVERED_METHODS: ReadonlySet<FulfillmentDeliveryMethod> = new Set([
    'shipping',
    'local',
]);

/** A claimed ledger row, as the worker hands it over. */
export interface ClaimedOrderEvent {
    id: string;
    organisation_id: string;
    platform: string;
    event_type: string;
    payload: OrderEventDto;
    attempts: number;
}

/**
 * What processing decided. `packageIds` lists every package the event is
 * linked to, whether made now or found from an earlier event or attempt, so a
 * `needs_attention` outcome can carry the packages its other groups produced.
 */
export type OrderEventOutcome =
    | { status: 'processed'; customerId: string; packageIds: string[] }
    | {
          status: 'skipped' | 'needs_attention';
          error: string;
          customerId?: string;
          packageIds?: string[];
      };

interface WarehouseRow {
    id: string;
    warehouse_name: string;
    warehouse_address: string;
    warehouse_city: string;
    warehouse_state: string;
    warehouse_zipcode: string;
    warehouse_country: string;
    lon: number;
    lat: number;
}

/** A package already made from this order, by any event. */
interface OrderPackageRow {
    id: string;
    to_customer: string;
    external_fulfillment_id: string | null;
}

/** A storefront location's mapping, with its warehouse when it has one. */
interface MappingRow extends Omit<WarehouseRow, 'id'> {
    external_location_id: string;
    external_location_name: string | null;
    mode: 'warehouse' | 'not_delivered' | 'unmapped';
    warehouse_id: string | null;
}

/** One package to make: where from, what it weighs, which group it is. */
interface PackageToCreate {
    warehouse: WarehouseRow;
    weightKg: number;
    fulfillmentId: string | null;
}

/**
 * Turns one recorded order event into a customer and its packages, and
 * assigns them: the second half of the generic ecommerce connector.
 *
 * An order without fulfillment groups becomes one package from the warehouse
 * nearest the recipient. An order with them becomes one package per group
 * that is delivered (`shipping` or `local`), each from the warehouse its
 * storefront location is mapped to. A group whose location is not mapped
 * never falls back to the nearest warehouse: the merchant has said where the
 * items are, so guessing would send a van to a depot that does not have them.
 *
 * Every outcome it can decide on is written back to the ledger row here:
 * `processed` (with the customer and packages it produced), `skipped`
 * (nothing to deliver) or `needs_attention` (a human has to fix something
 * first; the groups that could be processed already have their packages). It
 * only throws for failures worth retrying (geocoder unreachable, database
 * error), which the worker turns into a backoff.
 *
 * IDEMPOTENT PER ORDER AND GROUP, not just per event. Each package commits
 * with its link to the event, and packages_org_external_fulfillment_key
 * allows one package per storefront order and group, so neither a worker that
 * dies halfway, a retry after a location is mapped, nor the same order
 * arriving under a second Idempotency-Key can put two parcels on a van.
 */
@Injectable()
export class OrderEventProcessor {
    private readonly logger = new Logger(OrderEventProcessor.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly customers: CustomersService,
        private readonly packages: PackagesService,
        private readonly geocoder: OrderGeocoder,
    ) {}

    async process(event: ClaimedOrderEvent): Promise<OrderEventOutcome> {
        const outcome = await this.decide(event);
        await this.complete(event.id, outcome);
        return outcome;
    }

    private async decide(event: ClaimedOrderEvent): Promise<OrderEventOutcome> {
        const { payload } = event;

        // Cancellations and refunds will arrive as their own event types; until
        // they do anything, recording them is all there is to do.
        if (event.event_type !== ORDER_PAID) {
            return {
                status: 'skipped',
                error: `Event type "${event.event_type}" does not create a package.`,
            };
        }

        const delivery = payload.delivery;
        if (!delivery?.required || !delivery.address) {
            return {
                status: 'skipped',
                error: 'The order needs no delivery (digital or pickup only).',
            };
        }

        const groups = payload.fulfillment_groups ?? [];
        return groups.length > 0
            ? this.decideGroups(event, groups)
            : this.decideOrder(event);
    }

    /** The whole order as one package, from the warehouse nearest the recipient. */
    private async decideOrder(
        event: ClaimedOrderEvent,
    ): Promise<OrderEventOutcome> {
        // The same order already became a package (or packages) through
        // another event.
        const existing = await this.findPackagesForOrder(event);
        if (existing.length > 0) {
            await this.link(this.dataSource, event.id, existing);
            return {
                status: 'processed',
                customerId: existing[0].to_customer,
                packageIds: existing.map((p) => p.id),
            };
        }

        let point: GeocodedPoint;
        try {
            point = await this.locate(event.payload);
        } catch (err) {
            if (err instanceof UngeocodableAddressError) {
                return { status: 'needs_attention', error: err.message };
            }
            throw err;
        }

        const customerId = await this.upsertRecipient(event, point);

        const warehouse = await this.nearestWarehouse(
            event.organisation_id,
            point,
        );
        if (!warehouse) {
            return {
                status: 'needs_attention',
                error: 'The organisation has no warehouse to dispatch this order from. Add one, then retry.',
                customerId,
            };
        }

        const packageIds = await this.createAndAssign(event, customerId, [
            {
                warehouse,
                weightKg: weightKg(event.payload),
                fulfillmentId: null,
            },
        ]);
        return { status: 'processed', customerId, packageIds };
    }

    /**
     * One package per delivered group, from its location's warehouse. Groups
     * that already have a package (an earlier attempt, a retry, the same order
     * under another key) are linked, not made again. The outcome is the worst
     * across the groups: any group that needs a human makes the event
     * `needs_attention`, but every group that could be processed still gets
     * its package.
     */
    private async decideGroups(
        event: ClaimedOrderEvent,
        groups: OrderFulfillmentGroupDto[],
    ): Promise<OrderEventOutcome> {
        const { payload } = event;
        const platform = platformLabel(event.platform);

        const existing = await this.findPackagesForOrder(event);

        // The order already became one whole-order package, through an event
        // sent before the store split it by location. Splitting it now would
        // put the same items on a van twice.
        const whole = existing.filter(
            (p) => p.external_fulfillment_id === null,
        );
        if (whole.length > 0) {
            await this.link(this.dataSource, event.id, whole);
            return {
                status: 'processed',
                customerId: whole[0].to_customer,
                packageIds: whole.map((p) => p.id),
            };
        }

        const shopDomain = normaliseShopDomain(payload.source.shop_domain);
        const mappings = shopDomain
            ? await this.findLocationMappings(event, shopDomain, groups)
            : new Map<string, MappingRow>();

        const linked: OrderPackageRow[] = [];
        const toCreate: PackageToCreate[] = [];
        const problems = new Set<string>();
        const skips: string[] = [];

        for (const group of groups) {
            const location = locationName(group, mappings);
            if (!DELIVERED_METHODS.has(group.delivery_method)) {
                skips.push(
                    `The items from ${platform} location '${location}' are ${
                        group.delivery_method === 'pickup'
                            ? 'picked up'
                            : 'not delivered'
                    }.`,
                );
                continue;
            }

            const done = existing.find(
                (p) => p.external_fulfillment_id === group.id,
            );
            if (done) {
                linked.push(done);
                continue;
            }

            if (!shopDomain) {
                problems.add(
                    `The order has no shop domain, so its ${platform} locations cannot be matched to Hikyaku warehouses. Send source.shop_domain, then retry.`,
                );
                continue;
            }

            const mapping = mappings.get(group.external_location_id);
            if (mapping?.mode === 'not_delivered') {
                skips.push(
                    `${platform} location '${location}' is not delivered by Hikyaku.`,
                );
                continue;
            }
            if (mapping?.mode !== 'warehouse' || !mapping.warehouse_id) {
                problems.add(
                    `${platform} location '${location}' isn't mapped to a Hikyaku warehouse. Map it in the ${platform} app, then retry.`,
                );
                continue;
            }

            toCreate.push({
                warehouse: { ...mapping, id: mapping.warehouse_id },
                weightKg: groupWeightKg(payload, group),
                fulfillmentId: group.id,
            });
        }

        await this.link(this.dataSource, event.id, linked);
        const packageIds = linked.map((p) => p.id);
        let customerId: string | undefined = existing[0]?.to_customer;

        if (toCreate.length > 0) {
            let point: GeocodedPoint | null = null;
            try {
                point = await this.locate(payload);
            } catch (err) {
                if (!(err instanceof UngeocodableAddressError)) throw err;
                problems.add(err.message);
            }
            if (point) {
                customerId = await this.upsertRecipient(event, point);
                packageIds.push(
                    ...(await this.createAndAssign(
                        event,
                        customerId,
                        toCreate,
                    )),
                );
            }
        }

        if (problems.size > 0) {
            return {
                status: 'needs_attention',
                error: [...problems].join(' '),
                customerId,
                packageIds,
            };
        }
        if (packageIds.length > 0 && customerId) {
            return { status: 'processed', customerId, packageIds };
        }
        return { status: 'skipped', error: skips.join(' ') };
    }

    /** Coordinates from the storefront when it sent them, else Photon. */
    private async locate(payload: OrderEventDto): Promise<GeocodedPoint> {
        const { latitude, longitude, address } = payload.delivery;
        if (
            typeof latitude === 'number' &&
            typeof longitude === 'number' &&
            Math.abs(latitude) <= 90 &&
            Math.abs(longitude) <= 180
        ) {
            return {
                lon: longitude,
                lat: latitude,
                confidence: 1,
                gid: null,
                raw: null,
            };
        }
        return this.geocoder.geocodeAddress(address!);
    }

    /** The person the parcels go to. */
    private async upsertRecipient(
        event: ClaimedOrderEvent,
        point: GeocodedPoint,
    ): Promise<string> {
        const { payload } = event;
        const { delivery } = payload;
        const address = delivery.address!;
        return this.customers.upsertFromExternalOrder(
            event.organisation_id,
            {
                name: recipientName(payload),
                phone: toE164OrNull(
                    delivery.phone ?? payload.customer?.phone ?? '',
                ),
                email: delivery.email ?? payload.customer?.email ?? null,
                address: {
                    lon: point.lon,
                    lat: point.lat,
                    street: address.line1 ?? '',
                    unit: address.line2,
                    suburb: address.city ?? '',
                    state: address.province_code ?? address.province ?? '',
                    postcode: address.postcode,
                    country: address.country_code ?? address.country ?? '',
                },
                confidence: point.confidence,
                peliasGid: point.gid,
                peliasRaw: point.raw,
            },
            payload.customer?.id
                ? {
                      platform: event.platform,
                      externalCustomerId: payload.customer.id,
                  }
                : null,
        );
    }

    /** The depot nearest the delivery point. */
    private async nearestWarehouse(
        organisationId: string,
        point: GeocodedPoint,
    ): Promise<WarehouseRow | null> {
        const rows: WarehouseRow[] = await this.dataSource.query(
            `SELECT id, warehouse_name, warehouse_address, warehouse_city,
                    warehouse_state, warehouse_zipcode, warehouse_country,
                    ST_X(warehouse_location::geometry) AS lon,
                    ST_Y(warehouse_location::geometry) AS lat
               FROM warehouse
              WHERE organisation_id = $1
              ORDER BY warehouse_location <-> ST_SetSRID(ST_Point($2, $3), 4326)
              LIMIT 1`,
            [organisationId, point.lon, point.lat],
        );
        return rows[0] ?? null;
    }

    /**
     * The stored mapping of every location the groups ship from, keyed by
     * external_location_id, each with its warehouse when it is mapped to one.
     * A location with no row at all is simply missing from the map.
     */
    private async findLocationMappings(
        event: ClaimedOrderEvent,
        shopDomain: string,
        groups: OrderFulfillmentGroupDto[],
    ): Promise<Map<string, MappingRow>> {
        const rows: MappingRow[] = await this.dataSource.query(
            `SELECT m.external_location_id, m.external_location_name, m.mode,
                    w.id AS warehouse_id, w.warehouse_name, w.warehouse_address,
                    w.warehouse_city, w.warehouse_state, w.warehouse_zipcode,
                    w.warehouse_country,
                    ST_X(w.warehouse_location::geometry) AS lon,
                    ST_Y(w.warehouse_location::geometry) AS lat
               FROM public.integration_location_mapping m
               LEFT JOIN public.warehouse w
                 ON w.organisation_id = m.organisation_id AND w.id = m.warehouse_id
              WHERE m.organisation_id = $1 AND m.platform = $2
                AND m.shop_domain = $3
                AND m.external_location_id = ANY($4::text[])`,
            [
                event.organisation_id,
                event.platform,
                shopDomain,
                [...new Set(groups.map((g) => g.external_location_id))],
            ],
        );
        return new Map(rows.map((row) => [row.external_location_id, row]));
    }

    /**
     * The package's sender: the store, at the warehouse it ships from.
     *
     * packages.from_customer is NOT NULL, and a storefront order has no sender
     * in the payload: the merchant is the sender. One customer row per store
     * and warehouse, matched on name (no phone, no email), so every order from
     * the same store and depot shares it rather than minting a new one.
     */
    private async upsertSender(
        event: ClaimedOrderEvent,
        warehouse: WarehouseRow,
    ): Promise<string> {
        const store = event.payload.source.shop_domain ?? event.platform;
        return this.customers.upsertFromExternalOrder(
            event.organisation_id,
            {
                name: `${store} (${warehouse.warehouse_name})`,
                phone: null,
                email: null,
                address: {
                    lon: Number(warehouse.lon),
                    lat: Number(warehouse.lat),
                    street: warehouse.warehouse_address,
                    suburb: warehouse.warehouse_city,
                    state: warehouse.warehouse_state,
                    postcode: warehouse.warehouse_zipcode,
                    country: warehouse.warehouse_country,
                },
            },
            null,
        );
    }

    /**
     * Makes each package, then assigns the ones this call made. Returns every
     * package id in the order given, with a lost race resolved to its winner.
     *
     * Assignment runs after the commits and is never fatal: a van with no room
     * today is a dispatch problem, and the package stays PENDING for the
     * replan worker either way.
     */
    private async createAndAssign(
        event: ClaimedOrderEvent,
        recipientId: string,
        specs: PackageToCreate[],
    ): Promise<string[]> {
        const ids: string[] = [];
        const made: string[] = [];
        for (const spec of specs) {
            const senderId = await this.upsertSender(event, spec.warehouse);
            const created = await this.createPackage(
                event,
                spec,
                senderId,
                recipientId,
            );
            ids.push(created.id);
            if (!created.raced) made.push(created.id);
        }

        if (made.length > 0) {
            try {
                await this.packages.assignCreated(event.organisation_id, made);
            } catch (err: unknown) {
                this.logger.warn(
                    `Assignment after order event ${event.id} failed; packages ${made.join(', ')} remain pending: ${String(err)}`,
                );
            }
        }
        return ids;
    }

    /**
     * Writes one package and links the ledger row to it on one transaction.
     * Losing a race to another event for the same order and group (23505 on
     * packages_org_external_fulfillment_key) links this row to the winner
     * instead.
     */
    private async createPackage(
        event: ClaimedOrderEvent,
        spec: PackageToCreate,
        senderId: string,
        recipientId: string,
    ): Promise<{ id: string; raced: boolean }> {
        const { payload } = event;
        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            const [id] = await this.packages.createMany(
                runner,
                event.organisation_id,
                [
                    {
                        warehouseId: spec.warehouse.id,
                        fromCustomerId: senderId,
                        toCustomerId: recipientId,
                        deliveryNotes: payload.delivery.instructions ?? null,
                        weightKg: spec.weightKg,
                        lengthCm: DEFAULT_DIMENSIONS_CM.length,
                        widthCm: DEFAULT_DIMENSIONS_CM.width,
                        heightCm: DEFAULT_DIMENSIONS_CM.height,
                        // No promise: the storefront sends no delivery date, and
                        // a package without a deadline is the one allowed to be
                        // bumped for a package that has one.
                        deadlineAt: null,
                        externalOrder: {
                            platform: event.platform,
                            id: payload.order.id,
                            name: payload.order.name ?? null,
                            fulfillmentId: spec.fulfillmentId,
                        },
                    },
                ],
            );
            await this.link(runner, event.id, [
                { id, external_fulfillment_id: spec.fulfillmentId },
            ]);
            await runner.commitTransaction();
            return { id, raced: false };
        } catch (err) {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            if ((err as { code?: string })?.code !== '23505') throw err;

            const winner = (await this.findPackagesForOrder(event)).find(
                (p) => p.external_fulfillment_id === spec.fulfillmentId,
            );
            if (!winner) throw err;
            await this.link(this.dataSource, event.id, [winner]);
            return { id: winner.id, raced: true };
        } finally {
            await runner.release();
        }
    }

    /** Every package already made from this storefront order, oldest first. */
    private async findPackagesForOrder(
        event: ClaimedOrderEvent,
    ): Promise<OrderPackageRow[]> {
        return this.dataSource.query(
            `SELECT id, to_customer, external_fulfillment_id FROM packages
              WHERE organisation_id = $1 AND external_platform = $2 AND external_order_id = $3
              ORDER BY created_at, id`,
            [event.organisation_id, event.platform, event.payload.order.id],
        );
    }

    /** Links the event to packages it made or found. Linking twice is a no-op. */
    private async link(
        executor: DataSource | QueryRunner,
        eventId: string,
        packages: Pick<OrderPackageRow, 'id' | 'external_fulfillment_id'>[],
    ): Promise<void> {
        if (packages.length === 0) return;
        await executor.query(
            `INSERT INTO public.integration_order_event_package
                 (event_id, package_id, external_fulfillment_id)
             SELECT $1, l.package_id, l.external_fulfillment_id
               FROM unnest($2::uuid[], $3::text[]) AS l(package_id, external_fulfillment_id)
             ON CONFLICT (event_id, package_id) DO NOTHING`,
            [
                eventId,
                packages.map((p) => p.id),
                packages.map((p) => p.external_fulfillment_id),
            ],
        );
    }

    /**
     * Writes the outcome. package_id keeps the first package for readers
     * written before an event could produce more than one;
     * integration_order_event_package has all of them.
     */
    private async complete(
        eventId: string,
        outcome: OrderEventOutcome,
    ): Promise<void> {
        await this.dataSource.query(
            `UPDATE public.integration_order_event
                SET status = $2, customer_id = $3, package_id = $4, error = $5,
                    processed_at = now(), claimed_at = NULL
              WHERE id = $1`,
            [
                eventId,
                outcome.status,
                outcome.customerId ?? null,
                outcome.packageIds?.[0] ?? null,
                outcome.status === 'processed' ? null : outcome.error,
            ],
        );
    }
}

/** delivery.recipient_name, then the customer's name, then the order number. */
function recipientName(payload: OrderEventDto): string {
    const fromCustomer = [
        payload.customer?.first_name,
        payload.customer?.last_name,
    ]
        .filter((part) => part?.trim())
        .join(' ');
    return (
        payload.delivery.recipient_name?.trim() ||
        fromCustomer ||
        payload.delivery.address?.company?.trim() ||
        `Order ${payload.order.name}`
    );
}

/**
 * A connector slug as people read it: "shopify" -> "Shopify",
 * "big-commerce" -> "Big Commerce". The slug is caller-supplied data, so
 * there is no table of platform names to look it up in.
 */
export function platformLabel(slug: string): string {
    return slug
        .split('-')
        .filter(Boolean)
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(' ');
}

/** The group's location by name: from the event, else the mapping, else its id. */
function locationName(
    group: OrderFulfillmentGroupDto,
    mappings: Map<string, MappingRow>,
): string {
    return (
        group.external_location_name?.trim() ||
        mappings.get(group.external_location_id)?.external_location_name ||
        group.external_location_id
    );
}

/** The form LocationMappingsService stores shop domains in. */
function normaliseShopDomain(domain: string | null | undefined): string {
    return domain?.trim().toLowerCase() ?? '';
}

/**
 * The order's total weight, else the shippable line items', else a default.
 * package_dimensions.weight_kg must be positive, and a digital line item
 * weighs nothing, so only items that ship are counted.
 */
export function weightKg(payload: OrderEventDto): number {
    const total = payload.order.total_weight_grams;
    if (typeof total === 'number' && total > 0) return total / 1000;

    const items = (payload.order.line_items ?? [])
        .filter((item) => item.requires_shipping)
        .reduce((sum, item) => sum + item.grams * item.quantity, 0);
    if (items > 0) return items / 1000;

    return DEFAULT_WEIGHT_KG;
}

/**
 * One group's weight: its own total, else its shippable line items' grams
 * times the quantity this group fulfils (less than the line item's own
 * quantity when a line is split across locations), else a default.
 */
export function groupWeightKg(
    payload: OrderEventDto,
    group: OrderFulfillmentGroupDto,
): number {
    const total = group.total_weight_grams;
    if (typeof total === 'number' && total > 0) return total / 1000;

    const byId = new Map(
        (payload.order.line_items ?? []).map((item) => [item.id, item]),
    );
    const items = group.line_items.reduce((sum, ref) => {
        const item = byId.get(ref.line_item_id);
        return item?.requires_shipping ? sum + item.grams * ref.quantity : sum;
    }, 0);
    if (items > 0) return items / 1000;

    return DEFAULT_WEIGHT_KG;
}
