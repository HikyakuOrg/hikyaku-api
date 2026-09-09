import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { CoverageOutcome } from 'src/dispatch/coverage';

@Entity('package_assignment')
export class PackageAssignment {
    @PrimaryColumn({ name: 'package_id', type: 'uuid' })
    packageId: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @Column({ name: 'driver_id', type: 'uuid' })
    driverId: string;

    @Column({ name: 'vehicle_id', type: 'uuid' })
    vehicleId: string;

    /**
     * How the driver that got this package related to who covers its delivery
     * point, recorded when the package was placed. Null for a row automatic
     * assignment did not write, i.e. a replan or a dispatcher's hand edit; see
     * AddAssignmentCoverageOutcome1788829200000 for why that is the useful
     * meaning of null rather than an omission.
     */
    @Column({ name: 'coverage_outcome', type: 'text', nullable: true })
    coverageOutcome: CoverageOutcome | null;
}
