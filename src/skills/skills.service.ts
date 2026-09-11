import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { CreateSkillDto, SkillDto } from './dto/skill.dto';

interface SkillRow {
    id: string;
    organisation_id: string;
    name: string;
    archived_at: string | null;
    created_at: string;
}

/**
 * The organisation's skill catalog: labels like "Fragile Handling" or
 * "Requires Liftgate", assigned to vehicles (vehicle_skills) and required by
 * packages (package_skills). The VROOM translation layer (HIK-92) matches
 * them as a hard constraint. See HIK-90 and the schema in
 * CreateSkillsSchema1789261200000.
 */
@Injectable()
export class SkillsService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async create(
        organisationId: string,
        dto: CreateSkillDto,
    ): Promise<SkillDto> {
        try {
            const rows: SkillRow[] = await this.dataSource.query(
                `INSERT INTO skills (organisation_id, name)
                 VALUES ($1, $2)
                 RETURNING id, organisation_id, name, archived_at, created_at`,
                [organisationId, dto.name.trim()],
            );
            return this.toDto(rows[0]);
        } catch (err: unknown) {
            if ((err as { code?: string })?.code === '23505') {
                throw new ConflictException(
                    `A skill named "${dto.name.trim()}" already exists in this organisation.`,
                );
            }
            throw err;
        }
    }

    /** Newest first. Archived rows are included only on request. */
    async list(
        organisationId: string,
        includeArchived: boolean,
    ): Promise<SkillDto[]> {
        const rows: SkillRow[] = await this.dataSource.query(
            `SELECT id, organisation_id, name, archived_at, created_at
               FROM skills
              WHERE organisation_id = $1
                AND ($2::boolean OR archived_at IS NULL)
              ORDER BY created_at DESC`,
            [organisationId, includeArchived],
        );
        return rows.map((row) => this.toDto(row));
    }

    /**
     * Retires a skill. Idempotent — archiving an already-archived skill just
     * returns it unchanged, via COALESCE, rather than bumping archivedAt to
     * now again.
     *
     * A hard delete is deliberately not exposed here: vehicle_skills,
     * package_skills and historical vrp_solution/vrp_route rows can still
     * reference this id, and a soft-deleted catalog entry is what lets those
     * stay resolvable. See CreateSkillsSchema1789261200000.
     */
    async archive(organisationId: string, skillId: string): Promise<SkillDto> {
        const rows: SkillRow[] = await this.dataSource.query(
            `UPDATE skills
                SET archived_at = COALESCE(archived_at, now())
              WHERE id = $1 AND organisation_id = $2
          RETURNING id, organisation_id, name, archived_at, created_at`,
            [skillId, organisationId],
        );
        if (!rows[0]) {
            throw new NotFoundException(
                'No skill with this id in the organisation.',
            );
        }
        return this.toDto(rows[0]);
    }

    /**
     * Confirms every id names an active skill in this organisation's catalog,
     * throwing a 400 otherwise. Mirrors PackagesService.validateReferences:
     * a skill id from another organisation, an unknown id, and an archived
     * id are all reported the same way — "not found" — rather than
     * disclosing which case applies.
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

    private toDto(row: SkillRow): SkillDto {
        return {
            id: row.id,
            organisationId: row.organisation_id,
            name: row.name,
            archivedAt: row.archived_at
                ? new Date(row.archived_at).toISOString()
                : null,
            createdAt: new Date(row.created_at).toISOString(),
        };
    }
}
