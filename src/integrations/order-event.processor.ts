import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { toE164OrNull } from 'src/common/phone';
import { CustomersService } from 'src/customers/customers.service';
import { PackagesService } from 'src/packages/packages.service';
import {
    ORDER_FULFILLMENT_UPDATED,
    ORDER_PAID,
    type FulfillmentDeliveryMethod,
    type OrderEventDto,
    type OrderFulfillmentGroupDto,
    type OrderPaidPayload,
} from './dto/order-event.dto';
import {
    OrderGeocoder,
    UngeocodableAddressError,
    type GeocodedPoint,
} from './order-geocoder';

/**
 * Storefronts send no parcel dimensions. Capacity matching uses only weight;
 * these values exist because package_dimensions requires them.
 */
const DEFAULT_DIMENSIONS_CM = { length: 30, width: 20, height: 15 };

/** Weight used when neither the order nor its line items carry one. */
const DEFAULT_WEIGHT_KG = 1;

/** Delivery methods that give Hikyaku a parcel to deliver. */
const DELIVERED_METHODS: ReadonlySet<FulfillmentDeliveryMethod> = new Set([
    'shipping',
    'local',
]);

/**
 * Statuses of a package that is not loaded yet. A re-routing can remove only
 * these packages.
 */
const REMOVABLE_STATUSES: ReadonlySet<string> = new Set([
    'PENDING',
    'ASSIGNED',
]);

/** Package weights closer than this, in kg, are the same parcel. */
const WEIGHT_TOLERANCE_KG = 0.001;

/** A ledger row claimed by the worker. */
export interface ClaimedOrderEvent {
    id: string;
    organisation_id: string;
    platform: string;
    event_type: string;
    payload: OrderEventDto;
    attempts: number;
}

/**
 * `packageIds` lists every package linked to the event, new or found. A
 * `needs_attention` outcome also carries the packages of the groups that
 * succeeded.
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
    tracking_number: string;
    warehouse_id: string | null;
    /** node-postgres returns numeric as a string. */
    weight_kg: string | number | null;
    /** Latest timeline status; null reads as PENDING. */
    status: string | null;
}

/** A storefront location's mapping, with its warehouse when it has one. */
interface MappingRow extends Omit<WarehouseRow, 'id'> {
    external_location_id: string;
    external_location_name: string | null;
    mode: 'warehouse' | 'not_delivered' | 'unmapped';
    warehouse_id: string | null;
}

interface PackageToCreate {
    warehouse: WarehouseRow;
    weightKg: number;
    fulfillmentId: string | null;
}

/** A package to unassign and delete. `reason` goes to the log. */
interface PackageToRemove {
    pkg: OrderPackageRow;
    reason: string;
}

/**
 * The event, and the order.paid body that supplies the recipient, items and
 * address. For `order.fulfillment_updated`, `paid` is the newest recorded
 * order.paid.
 */
interface OrderContext {
    event: ClaimedOrderEvent;
    paid: OrderPaidPayload;
}

/** An order's current routing, from all its recorded events. */
export interface OrderRouting {
    /** The newest order.paid body, or null when none has arrived yet. */
    paid: OrderPaidPayload | null;
    /**
     * Groups from the newest event that has them. Null means the order ships
     * as one package.
     */
    groups: OrderFulfillmentGroupDto[] | null;
    /** Groups the storefront re-routed or cancelled, and no longer lists. */
    released: Set<string>;
}

/**
 * Turns recorded order events into a customer and packages.
 *
 * `order.paid`: an order without fulfillment groups becomes one package from
 * the nearest warehouse. An order with groups becomes one package per
 * delivered group, from the warehouse its location is mapped to. An unmapped
 * location never falls back to the nearest warehouse, because that warehouse
 * may not have the items.
 *
 * `order.fulfillment_updated`: reconciles the order's packages with its
 * current groups (see decideGroups). If a package to change is already
 * loaded, nothing changes and the event needs attention.
 *
 * Both event types use the order's current routing (see routingOf), so a
 * retried order.paid uses the latest groups.
 *
 * Writes every outcome to the ledger row. Throws only for failures to retry
 * (geocoder down, database error, a package put back on a shift during
 * removal); the worker backs off on these.
 *
 * Idempotent per order and group: packages_org_external_fulfillment_key
 * allows one package per order and group, and each package commits with its
 * event link. A crash, a retry or a second Idempotency-Key cannot create a
 * second package.
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
        const reroute = event.event_type === ORDER_FULFILLMENT_UPDATED;

        // Other event types (cancellations, refunds) are only recorded for now.
        if (event.event_type !== ORDER_PAID && !reroute) {
            return {
                status: 'skipped',
                error: `Event type "${event.event_type}" does not create a package.`,
            };
        }

        const routing = await this.loadRouting(event);
        const paid = reroute
            ? routing.paid
            : (event.payload as OrderPaidPayload);
        if (!paid) {
            return {
                status: 'skipped',
                error: 'No order.paid event has been received for this order yet. When it arrives, the order is dispatched as it is routed then.',
            };
        }

        const delivery = paid.delivery;
        if (!delivery?.required || !delivery.address) {
            return {
                status: 'skipped',
                error: 'The order needs no delivery (digital or pickup only).',
            };
        }

        const context: OrderContext = { event, paid };
        return routing.groups
            ? this.decideGroups(context, routing.groups, routing.released)
            : this.decideOrder(context);
    }

    /**
     * Reads the order's routing from all its recorded events. Orders by
     * receive time, because the connector reads the routing just before it
     * sends. Events of every status count, skipped ones too.
     */
    private async loadRouting(event: ClaimedOrderEvent): Promise<OrderRouting> {
        const rows: {
            id: string;
            event_type: string;
            payload: OrderEventDto;
        }[] = await this.dataSource.query(
            `SELECT id, event_type, payload FROM public.integration_order_event
              WHERE organisation_id = $1 AND platform = $2 AND external_order_id = $3
                AND event_type = ANY($4::text[])
              ORDER BY created_at, id`,
            [
                event.organisation_id,
                event.platform,
                event.payload.order.id,
                [ORDER_PAID, ORDER_FULFILLMENT_UPDATED],
            ],
        );
        // If the read misses the current event, add it as the newest.
        if (!rows.some((row) => row.id === event.id)) {
            rows.push({
                id: event.id,
                event_type: event.event_type,
                payload: event.payload,
            });
        }
        return routingOf(rows);
    }

    /** The whole order as one package, from the warehouse nearest the recipient. */
    private async decideOrder(
        context: OrderContext,
    ): Promise<OrderEventOutcome> {
        const { event, paid } = context;

        // Another event already made packages for this order.
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
            point = await this.locate(paid);
        } catch (err) {
            if (err instanceof UngeocodableAddressError) {
                return { status: 'needs_attention', error: err.message };
            }
            throw err;
        }

        const customerId = await this.upsertRecipient(context, point);

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

        const packageIds = await this.createAndAssign(context, customerId, [
            {
                warehouse,
                weightKg: weightKg(paid),
                fulfillmentId: null,
            },
        ]);
        return { status: 'processed', customerId, packageIds };
    }

    /**
     * One package per delivered group, from its location's warehouse.
     * order.paid links groups that already have a package. On
     * order.fulfillment_updated, a package whose group changed or was
     * released is replaced or removed first.
     *
     * If one group needs a human, the event is `needs_attention`, but the
     * other groups still get their packages.
     */
    private async decideGroups(
        context: OrderContext,
        groups: OrderFulfillmentGroupDto[],
        released: Set<string>,
    ): Promise<OrderEventOutcome> {
        const { event, paid } = context;
        const reroute = event.event_type === ORDER_FULFILLMENT_UPDATED;
        const platform = platformLabel(event.platform);

        const existing = await this.findPackagesForOrder(event);

        // An earlier event made one whole-order package before the store split
        // the order. Splitting now would ship the same items twice.
        const whole = existing.filter(
            (p) => p.external_fulfillment_id === null,
        );
        if (whole.length > 0) {
            await this.link(this.dataSource, event.id, whole);
            const packageIds = whole.map((p) => p.id);
            const customerId = whole[0].to_customer;
            if (!reroute) {
                return { status: 'processed', customerId, packageIds };
            }
            return {
                status: 'needs_attention',
                error: `The order was dispatched as one package (${trackingNumbers(whole)}) before ${platform} routed it by location, so its re-routing was not applied. Check the package by hand.`,
                customerId,
                packageIds,
            };
        }

        const shopDomain = normaliseShopDomain(paid.source.shop_domain);
        const mappings = shopDomain
            ? await this.findLocationMappings(event, shopDomain, groups)
            : new Map<string, MappingRow>();

        const byGroup = new Map(
            existing.map((p) => [p.external_fulfillment_id, p]),
        );
        const kept: OrderPackageRow[] = [];
        const toRemove: PackageToRemove[] = [];
        const toCreate: PackageToCreate[] = [];
        const problems = new Set<string>();
        const skips: string[] = [];

        for (const group of groups) {
            const location = locationName(group, mappings);
            const current = byGroup.get(group.id);

            // order.paid keeps existing packages.
            if (current && !reroute) {
                kept.push(current);
                continue;
            }

            if (!DELIVERED_METHODS.has(group.delivery_method)) {
                const how =
                    group.delivery_method === 'pickup'
                        ? 'picked up'
                        : 'not delivered';
                skips.push(
                    `The items from ${platform} location '${location}' are ${how}.`,
                );
                if (current) {
                    toRemove.push({ pkg: current, reason: `now ${how}` });
                }
                continue;
            }

            if (!shopDomain) {
                // No shop domain, so no mapping to compare the package with.
                if (current) {
                    kept.push(current);
                    continue;
                }
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
                if (current) {
                    toRemove.push({
                        pkg: current,
                        reason: `now ships from '${location}', which Hikyaku does not deliver for`,
                    });
                }
                continue;
            }
            if (mapping?.mode !== 'warehouse' || !mapping.warehouse_id) {
                problems.add(
                    `${platform} location '${location}' isn't mapped to a Hikyaku warehouse. Map it in the ${platform} app, then retry.`,
                );
                if (current) {
                    toRemove.push({
                        pkg: current,
                        reason: `now ships from unmapped location '${location}'`,
                    });
                }
                continue;
            }

            const wanted: PackageToCreate = {
                warehouse: { ...mapping, id: mapping.warehouse_id },
                weightKg: groupWeightKg(paid, group),
                fulfillmentId: group.id,
            };
            if (current) {
                const change = packageChange(current, wanted);
                if (!change) {
                    kept.push(current);
                    continue;
                }
                toRemove.push({ pkg: current, reason: change });
            }
            toCreate.push(wanted);
        }

        // Remove the packages of released groups. An unlisted group that is
        // not released (fulfilled, for example) keeps its package.
        const listed = new Set(groups.map((g) => g.id));
        for (const pkg of existing) {
            const groupId = pkg.external_fulfillment_id;
            if (reroute && groupId && !listed.has(groupId)) {
                if (released.has(groupId)) {
                    toRemove.push({ pkg, reason: 'released' });
                }
            }
        }

        // If a package to remove is loaded or delivered, change nothing. The
        // new groups can contain the same items.
        const moving = toRemove.filter(
            ({ pkg }) => !REMOVABLE_STATUSES.has(pkg.status ?? 'PENDING'),
        );
        if (moving.length > 0) {
            const packageIds = existing.map((p) => p.id);
            await this.link(this.dataSource, event.id, existing);
            return {
                status: 'needs_attention',
                error: `${platform} re-routed items that have already left the depot, so nothing was changed: ${moving
                    .map(
                        ({ pkg }) =>
                            `package ${pkg.tracking_number} is ${pkg.status}`,
                    )
                    .join(
                        ', ',
                    )}. Sort the order out by hand, then retry if it still needs new packages.`,
                customerId: existing[0]?.to_customer,
                packageIds,
            };
        }

        for (const { pkg, reason } of toRemove) {
            await this.packages.deleteUndispatched(
                event.organisation_id,
                pkg.id,
            );
            this.logger.log(
                `Order event ${event.id}: removed package ${pkg.id} (${pkg.tracking_number}) for fulfillment group ${pkg.external_fulfillment_id}: ${reason}.`,
            );
        }

        await this.link(this.dataSource, event.id, kept);
        const packageIds = kept.map((p) => p.id);
        let customerId: string | undefined = existing[0]?.to_customer;

        if (toCreate.length > 0) {
            let point: GeocodedPoint | null = null;
            try {
                point = await this.locate(paid);
            } catch (err) {
                if (!(err instanceof UngeocodableAddressError)) throw err;
                problems.add(err.message);
            }
            if (point) {
                customerId = await this.upsertRecipient(context, point);
                packageIds.push(
                    ...(await this.createAndAssign(
                        context,
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
        // A re-routing that only removed packages is still processed.
        if (customerId && (packageIds.length > 0 || toRemove.length > 0)) {
            return { status: 'processed', customerId, packageIds };
        }
        return {
            status: 'skipped',
            error: skips.join(' ') || 'Nothing is left to deliver.',
        };
    }

    /** Coordinates from the storefront when it sent them, else Photon. */
    private async locate(paid: OrderPaidPayload): Promise<GeocodedPoint> {
        const { latitude, longitude, address } = paid.delivery;
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
        { event, paid }: OrderContext,
        point: GeocodedPoint,
    ): Promise<string> {
        const { delivery } = paid;
        const address = delivery.address!;
        return this.customers.upsertFromExternalOrder(
            event.organisation_id,
            {
                name: recipientName(paid),
                phone: toE164OrNull(
                    delivery.phone ?? paid.customer?.phone ?? '',
                ),
                email: delivery.email ?? paid.customer?.email ?? null,
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
            paid.customer?.id
                ? {
                      platform: event.platform,
                      externalCustomerId: paid.customer.id,
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
     * Mappings of the groups' locations, keyed by external_location_id. A
     * location with no row is absent from the map.
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
     * The sender: the store, at the warehouse it ships from.
     * packages.from_customer is NOT NULL, and the payload has no sender. The
     * row matches on name only, so all orders from one store and warehouse
     * share it.
     */
    private async upsertSender(
        { event, paid }: OrderContext,
        warehouse: WarehouseRow,
    ): Promise<string> {
        const store = paid.source.shop_domain ?? event.platform;
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
     * Creates each package, then assigns the new ones. Returns the ids in
     * input order; a lost race returns the winner's id.
     *
     * An assignment failure is not fatal. The package stays PENDING for the
     * replan worker.
     */
    private async createAndAssign(
        context: OrderContext,
        recipientId: string,
        specs: PackageToCreate[],
    ): Promise<string[]> {
        const { event } = context;
        const ids: string[] = [];
        const made: string[] = [];
        for (const spec of specs) {
            const senderId = await this.upsertSender(context, spec.warehouse);
            const created = await this.createPackage(
                context,
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
     * Creates one package and its event link in one transaction. On a race
     * for the same order and group (23505 on
     * packages_org_external_fulfillment_key), links the winner instead.
     */
    private async createPackage(
        { event, paid }: OrderContext,
        spec: PackageToCreate,
        senderId: string,
        recipientId: string,
    ): Promise<{ id: string; raced: boolean }> {
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
                        deliveryNotes: paid.delivery.instructions ?? null,
                        weightKg: spec.weightKg,
                        lengthCm: DEFAULT_DIMENSIONS_CM.length,
                        widthCm: DEFAULT_DIMENSIONS_CM.width,
                        heightCm: DEFAULT_DIMENSIONS_CM.height,
                        // The storefront sends no delivery date. A package
                        // without a deadline can be bumped for one with a
                        // deadline.
                        deadlineAt: null,
                        externalOrder: {
                            platform: event.platform,
                            id: paid.order.id,
                            name: paid.order.name ?? null,
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

    /**
     * Packages already made from this order, oldest first, with the warehouse,
     * weight and status that a re-routing compares.
     */
    private async findPackagesForOrder(
        event: ClaimedOrderEvent,
    ): Promise<OrderPackageRow[]> {
        return this.dataSource.query(
            `SELECT p.id, p.to_customer, p.external_fulfillment_id,
                    p.tracking_number, p.warehouse_id, d.weight_kg,
                    latest.enums AS status
               FROM packages p
               LEFT JOIN package_dimensions d ON d.package_id = p.id
               LEFT JOIN LATERAL (
                    SELECT ps.enums
                      FROM package_timeline pt
                      JOIN package_status  ps ON ps.id = pt.package_status
                     WHERE pt.package_id = p.id
                     ORDER BY pt.created_at DESC, pt.id DESC
                     LIMIT 1
               ) latest ON true
              WHERE p.organisation_id = $1 AND p.external_platform = $2 AND p.external_order_id = $3
              ORDER BY p.created_at, p.id`,
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
     * Writes the outcome. package_id holds the first package for older
     * readers; integration_order_event_package holds all of them.
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

/**
 * Folds an order's events, oldest first, into its current routing:
 * - `paid`: the newest order.paid.
 * - `groups`: from the newest event with groups. An order.paid counts only if
 *   it has groups; an update always counts, even with none.
 * - `released`: ids released by any update, less groups listed again.
 */
export function routingOf(
    events: { event_type: string; payload: OrderEventDto }[],
): OrderRouting {
    let paid: OrderPaidPayload | null = null;
    let groups: OrderFulfillmentGroupDto[] | null = null;
    const released = new Set<string>();

    for (const { event_type: type, payload } of events) {
        if (type === ORDER_PAID) {
            paid = payload as OrderPaidPayload;
            if (payload.fulfillment_groups?.length) {
                groups = payload.fulfillment_groups;
            }
        } else if (type === ORDER_FULFILLMENT_UPDATED) {
            groups = payload.fulfillment_groups ?? [];
            for (const id of payload.released_group_ids ?? []) {
                released.add(id);
            }
        }
    }
    for (const group of groups ?? []) released.delete(group.id);

    return { paid, groups, released };
}

/**
 * Why a package no longer matches its group (another warehouse or weight), or
 * null if it matches.
 */
function packageChange(
    pkg: OrderPackageRow,
    wanted: PackageToCreate,
): string | null {
    if (pkg.warehouse_id !== wanted.warehouse.id) {
        return `now ships from warehouse ${wanted.warehouse.warehouse_name}`;
    }
    const weight = Number(pkg.weight_kg);
    if (
        pkg.weight_kg === null ||
        !Number.isFinite(weight) ||
        Math.abs(weight - wanted.weightKg) > WEIGHT_TOLERANCE_KG
    ) {
        return `now weighs ${wanted.weightKg} kg`;
    }
    return null;
}

function trackingNumbers(packages: OrderPackageRow[]): string {
    return packages.map((p) => p.tracking_number).join(', ');
}

/** recipient_name, else the customer's name, else company, else order name. */
function recipientName(paid: OrderPaidPayload): string {
    const fromCustomer = [paid.customer?.first_name, paid.customer?.last_name]
        .filter((part) => part?.trim())
        .join(' ');
    return (
        paid.delivery.recipient_name?.trim() ||
        fromCustomer ||
        paid.delivery.address?.company?.trim() ||
        `Order ${paid.order.name}`
    );
}

/** Display name of a connector slug: "big-commerce" -> "Big Commerce". */
export function platformLabel(slug: string): string {
    return slug
        .split('-')
        .filter(Boolean)
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(' ');
}

/** Location name from the event, else the mapping, else the location id. */
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
 * Order weight in kg: total_weight_grams, else the sum of the shippable line
 * items, else DEFAULT_WEIGHT_KG.
 */
export function weightKg(paid: OrderPaidPayload): number {
    const total = paid.order.total_weight_grams;
    if (typeof total === 'number' && total > 0) return total / 1000;

    const items = (paid.order.line_items ?? [])
        .filter((item) => item.requires_shipping)
        .reduce((sum, item) => sum + item.grams * item.quantity, 0);
    if (items > 0) return items / 1000;

    return DEFAULT_WEIGHT_KG;
}

/**
 * Group weight in kg: total_weight_grams, else grams x the group's quantity
 * for each shippable line item, else DEFAULT_WEIGHT_KG. A line item that the
 * order does not list (added by a later edit) counts as zero.
 */
export function groupWeightKg(
    paid: OrderPaidPayload,
    group: OrderFulfillmentGroupDto,
): number {
    const total = group.total_weight_grams;
    if (typeof total === 'number' && total > 0) return total / 1000;

    const byId = new Map(
        (paid.order.line_items ?? []).map((item) => [item.id, item]),
    );
    const items = group.line_items.reduce((sum, ref) => {
        const item = byId.get(ref.line_item_id);
        return item?.requires_shipping ? sum + item.grams * ref.quantity : sum;
    }, 0);
    if (items > 0) return items / 1000;

    return DEFAULT_WEIGHT_KG;
}
