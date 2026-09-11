import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * The organisation's skill catalog: labels like "Fragile Handling" or
 * "Requires Liftgate", assigned to vehicles (vehicle_skills) and required by
 * packages (package_skills). The VROOM translation layer (HIK-92) matches
 * them as a hard constraint. See HIK-90 and the schema in
 * CreateSkillsSchema1789261500000.
 *
 * Catalog CRUD is deliberately not here — clients create, rename and archive
 * skills directly through PostgREST, which RLS already gates on
 * `vehicles.update`. See SkillsModule for why the HTTP surface went away.
 */
@Injectable()
export class SkillsService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /**
     * Confirms every id names an active skill in this organisation's catalog,
     * throwing a 400 otherwise. Mirrors PackagesService.validateReferences:
     * a skill id from another organisation, an unknown id, and an archived
     * id are all reported the same way — "not found" — rather than
     * disclosing which case applies.
     *
     * The archived check is the reason this survives on the API side at all:
     * the RLS policies on `skills` gate *who* may write, not *which* rows stay
     * assignable, so a direct PostgREST insert into vehicle_skills can still
     * pair a vehicle with a retired skill. Package creation goes through
     * POST /api/v1/packages, so this path can and does enforce it.
     */
    async validateSkillIds(
        organisationId: string,
        skillIds: readonly string[],
    ): Promise<void> {
        if (skillIds.length === 0) return;

        const unique = [...new Set(skillIds)];
        const rows: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM skills
              WHERE id = ANY($1::uuid[]) AND organisation_id = $2 AND archived_at IS NULL`,
            [unique, organisationId],
        );
        const known = new Set(rows.map((row) => row.id));
        const missing = unique.filter((id) => !known.has(id));
        if (missing.length > 0) {
            throw new BadRequestException(
                `Skill not found for this organisation: ${missing.join(', ')}`,
            );
        }
    }
}
