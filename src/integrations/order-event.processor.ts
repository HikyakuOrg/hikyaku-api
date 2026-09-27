import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { toE164OrNull } from 'src/common/phone';
import { CustomersService } from 'src/customers/customers.service';
import { PackagesService } from 'src/packages/packages.service';
import type { OrderEventDto } from './dto/order-event.dto';
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

/** A claimed ledger row, as the worker hands it over. */
export interface ClaimedOrderEvent {
    id: string;
    organisation_id: string;
    platform: string;
    event_type: string;
    payload: OrderEventDto;
    attempts: number;
}

export type OrderEventOutcome =
    | { status: 'processed'; customerId: string; packageId: string }
    | {
          status: 'skipped' | 'needs_attention';
          error: string;
          customerId?: string;
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

/**
 * Turns one recorded order event into a customer and a package, and assigns
 * the package: the second half of the generic ecommerce connector.
 *
 * Every outcome it can decide on is written back to the ledger row here:
 * `processed` (with the customer and package it produced), `skipped` (nothing
 * to deliver) or `needs_attention` (a human has to fix something first). It
 * only throws for failures worth retrying (geocoder unreachable, database
 * error), which the worker turns into a backoff.
 *
 * IDEMPOTENT PER ORDER, not just per event. The package and the ledger update
 * commit together, and packages_org_external_order_key allows one package per
 * storefront order, so neither a worker that dies halfway nor the same order
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
        if (outcome.status !== 'processed') {
            await this.complete(this.dataSource, event.id, outcome);
        }
        return outcome;
    }

    private async decide(event: ClaimedOrderEvent): Promise<OrderEventOutcome> {
        const { payload } = event;
        const orgId = event.organisation_id;

        // Cancellations and refunds will arrive as their own event types; until
        // they do anything, recording them is all there is to do.
        if (event.event_type !== ORDER_PAID) {
            return {
                status: 'skipped',
                error: `Event type "${event.event_type}" does not create a package.`,
            };
        }

        const delivery = payload.delivery;
        const address = delivery?.address;
        if (!delivery?.required || !address) {
            return {
                status: 'skipped',
                error: 'The order needs no delivery (digital or pickup only).',
            };
        }

        // The same order already became a package through another event.
        const existing = await this.findPackageForOrder(
            orgId,
            event.platform,
            payload.order.id,
        );
        if (existing) {
            await this.complete(this.dataSource, event.id, {
                status: 'processed',
                ...existing,
            });
            return { status: 'processed', ...existing };
        }

        let point: GeocodedPoint;
        try {
            point = await this.locate(payload);
        } catch (err) {
            if (err instanceof UngeocodableAddressError) {
                return { status: 'needs_attention', error: err.message };
            }
            throw err;
        }

        const customerId = await this.customers.upsertFromExternalOrder(
            orgId,
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

        const warehouse = await this.nearestWarehouse(orgId, point);
        if (!warehouse) {
            return {
                status: 'needs_attention',
                error: 'The organisation has no warehouse to dispatch this order from. Add one, then retry.',
                customerId,
            };
        }
        const senderId = await this.upsertSender(event, warehouse);

        const created = await this.createPackage(
            event,
            warehouse.id,
            senderId,
            customerId,
        );
        if (created.raced) {
            return { status: 'processed', ...created.existing };
        }

        // After the commit, and never fatal: a van with no room today is a
        // dispatch problem, and the package stays PENDING for the replan
        // worker either way.
        try {
            await this.packages.assignCreated(orgId, [created.id]);
        } catch (err: unknown) {
            this.logger.warn(
                `Assignment after order event ${event.id} failed; package ${created.id} remains pending: ${String(err)}`,
            );
        }

        return { status: 'processed', customerId, packageId: created.id };
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
     * Writes the package and links the ledger row to it on one transaction.
     * Losing a race to another event for the same order (23505 on
     * packages_org_external_order_key) links this row to the winner instead.
     */
    private async createPackage(
        event: ClaimedOrderEvent,
        warehouseId: string,
        senderId: string,
        recipientId: string,
    ): Promise<
        | { raced: false; id: string }
        | { raced: true; existing: { customerId: string; packageId: string } }
    > {
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
                        warehouseId,
                        fromCustomerId: senderId,
                        toCustomerId: recipientId,
                        deliveryNotes: payload.delivery.instructions ?? null,
                        weightKg: weightKg(payload),
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
                        },
                    },
                ],
            );
            await this.complete(runner, event.id, {
                status: 'processed',
                customerId: recipientId,
                packageId: id,
            });
            await runner.commitTransaction();
            return { raced: false, id };
        } catch (err) {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            if ((err as { code?: string })?.code !== '23505') throw err;

            const existing = await this.findPackageForOrder(
                event.organisation_id,
                event.platform,
                payload.order.id,
            );
            if (!existing) throw err;
            await this.complete(this.dataSource, event.id, {
                status: 'processed',
                ...existing,
            });
            return { raced: true, existing };
        } finally {
            await runner.release();
        }
    }

    private async findPackageForOrder(
        organisationId: string,
        platform: string,
        externalOrderId: string,
    ): Promise<{ customerId: string; packageId: string } | null> {
        const rows: { id: string; to_customer: string }[] =
            await this.dataSource.query(
                `SELECT id, to_customer FROM packages
                  WHERE organisation_id = $1 AND external_platform = $2 AND external_order_id = $3`,
                [organisationId, platform, externalOrderId],
            );
        return rows[0]
            ? { customerId: rows[0].to_customer, packageId: rows[0].id }
            : null;
    }

    private async complete(
        executor: DataSource | QueryRunner,
        eventId: string,
        outcome: OrderEventOutcome,
    ): Promise<void> {
        await executor.query(
            `UPDATE public.integration_order_event
                SET status = $2, customer_id = $3, package_id = $4, error = $5,
                    processed_at = now(), claimed_at = NULL
              WHERE id = $1`,
            [
                eventId,
                outcome.status,
                outcome.customerId ?? null,
                outcome.status === 'processed' ? outcome.packageId : null,
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
