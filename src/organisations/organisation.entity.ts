import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('organisations')
export class Organisation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'text' })
    slug: string;

    @Column({ type: 'text' })
    name: string;

    /** 'personal' | 'company' — determines whether Stripe Connect onboarding is required. */
    @Column({ name: 'org_type', type: 'text', default: 'personal' })
    orgType: string;

    @Column({ name: 'created_by', type: 'uuid' })
    createdBy: string;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
