import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ServiceAddon } from './service-addon.entity';

/**
 * A priced service offering. Stripe (on the org's connected account) is the
 * source of truth for the price, currency and timestamps — this row holds only
 * the org scoping, the Stripe id mapping and our custom `pricing_unit` (how the
 * Checkout `quantity` is derived at booking time). The display name lives on the
 * Stripe product, not here.
 */
@Entity('services')
export class Service {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @Column({ name: 'stripe_product_id', type: 'text' })
    stripeProductId: string;

    @Column({ name: 'stripe_price_id', type: 'text' })
    stripePriceId: string;

    @Column({ name: 'pricing_unit', type: 'text' })
    pricingUnit: string;

    @OneToMany(() => ServiceAddon, (addon) => addon.service)
    addons: ServiceAddon[];
}
