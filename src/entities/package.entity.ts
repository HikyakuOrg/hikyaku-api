import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('packages')
export class Package {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'optimisation_id', type: 'uuid', nullable: true })
    optimisationId: string | null;

    /**
     * How many times this package has been bumped off a shift to make room for a
     * package that has a deadline. At MAX_EVICTIONS it stops being a candidate,
     * which is what bounds the eviction rule and stops deadline-less freight
     * from starving.
     */
    @Column({ name: 'eviction_count', type: 'int', default: 0 })
    evictionCount: number;
}
