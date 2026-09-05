import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class InsertPackageStatus1785199087000 implements MigrationInterface {
    name = 'InsertPackageStatus1785199087000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1785199087000-insert_package_status.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {}
}
