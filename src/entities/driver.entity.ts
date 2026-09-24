import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('drivers')
export class Driver {
    @PrimaryColumn({ type: 'uuid' })
    id: string;

    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @Column({ name: 'driver_license', type: 'text', nullable: true })
    driverLicense: string | null;

    @Column({ name: 'license_expiry', type: 'date', nullable: true })
    licenseExpiry: string | null;

    @Column({ name: 'warehouse_id', type: 'uuid', nullable: true })
    warehouseId: string | null;

    @Column({ name: 'country_of_issue', type: 'text', nullable: true })
    countryOfIssue: string | null;

    @Column({ name: 'driver_under_probation', type: 'boolean', nullable: true })
    driverUnderProbation: boolean | null;

    @Column({ name: 'license_type', type: 'uuid', nullable: true })
    licenseType: string | null;
}
