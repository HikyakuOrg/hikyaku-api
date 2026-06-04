import {
    Column,
    Entity,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Service } from './service.entity';

/**
 * A customer-selectable optional extra on a {@link Service}. Same Stripe-as-truth
 * model as the parent: only ids + `pricing_unit` are stored; price/currency/name
 * live on the Stripe product/price. Inherits the parent service's currency.
 */
@Entity('service_addons')
export class ServiceAddon {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'service_id', type: 'uuid' })
    serviceId: string;

    @ManyToOne(() => Service, (service) => service.addons, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'service_id' })
    service: Service;

    @Column({ name: 'stripe_product_id', type: 'text' })
    stripeProductId: string;

    @Column({ name: 'stripe_price_id', type: 'text' })
    stripePriceId: string;

    @Column({ name: 'pricing_unit', type: 'text' })
    pricingUnit: string;
}
