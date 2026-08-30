import { MigrationInterface, QueryRunner } from 'typeorm'
import { readFileSync } from 'fs'
import { join } from 'path'

export class AddPackageProofOfDeliveryDescription1787100600000 implements MigrationInterface {
  private read(file: string): string {
    return readFileSync(join(__dirname, file), 'utf8').trim()
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      this.read('1787100600000-add_package_proof_of_delivery_description.sql'),
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table public.package_proof_of_delivery drop column description`,
    )
  }
}
