import {
    BadRequestException,
    ConflictException,
    NotFoundException,
} from '@nestjs/common';
import { SkillsService } from './skills.service';

const ROW = {
    id: 'skill-1',
    organisation_id: 'org-1',
    name: 'Requires Liftgate',
    archived_at: null,
    created_at: '2026-09-01T09:00:00.000Z',
};

function build(answer: (sql: string, params: unknown[]) => unknown[] | Error) {
    const log: { sql: string; params: unknown[] }[] = [];
    const query = jest.fn((sql: string, params: unknown[] = []) => {
        log.push({ sql, params });
        const result = answer(sql, params);
        return result instanceof Error
            ? Promise.reject(result)
            : Promise.resolve(result);
    });
    const service = new SkillsService({ query } as never);
    return { service, log };
}

describe('SkillsService', () => {
    describe('create', () => {
        it('inserts a trimmed name and returns the mapped row', async () => {
            const { service, log } = build(() => [ROW]);
            const result = await service.create('org-1', {
                name: '  Requires Liftgate  ',
            });

            expect(result).toEqual({
                id: 'skill-1',
                organisationId: 'org-1',
                name: 'Requires Liftgate',
                archivedAt: null,
                createdAt: ROW.created_at,
            });
            expect(log[0].params).toEqual(['org-1', 'Requires Liftgate']);
        });

        it('reports a duplicate name in the same organisation as a conflict', async () => {
            const { service } = build(() =>
                Object.assign(new Error('duplicate key'), { code: '23505' }),
            );
            await expect(
                service.create('org-1', { name: 'Requires Liftgate' }),
            ).rejects.toBeInstanceOf(ConflictException);
        });
    });

    describe('list', () => {
        it('excludes archived rows by default', async () => {
            const { service, log } = build(() => [ROW]);
            await service.list('org-1', false);
            expect(log[0].params).toEqual(['org-1', false]);
        });

        it('includes archived rows on request', async () => {
            const { service, log } = build(() => [ROW]);
            await service.list('org-1', true);
            expect(log[0].params).toEqual(['org-1', true]);
        });
    });

    describe('archive', () => {
        it('404s for a skill in another organisation', async () => {
            const { service } = build(() => []);
            await expect(
                service.archive('org-1', 'skill-1'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('returns the archived row', async () => {
            const archived = {
                ...ROW,
                archived_at: '2026-09-05T00:00:00.000Z',
            };
            const { service } = build(() => [archived]);
            const result = await service.archive('org-1', 'skill-1');
            expect(result.archivedAt).toBe('2026-09-05T00:00:00.000Z');
        });
    });

    describe('validateSkillIds', () => {
        it('does nothing for an empty list, with no query', async () => {
            const { service, log } = build(() => [ROW]);
            await service.validateSkillIds('org-1', []);
            expect(log).toHaveLength(0);
        });

        it('passes when every id is active in this organisation', async () => {
            const { service } = build(() => [{ id: 'skill-1' }]);
            await expect(
                service.validateSkillIds('org-1', ['skill-1']),
            ).resolves.toBeUndefined();
        });

        it('rejects an id from another organisation the same as an unknown one', async () => {
            const { service } = build(() => []);
            await expect(
                service.validateSkillIds('org-1', ['skill-x']),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects an archived skill, since the query filters archived_at IS NULL', async () => {
            const { service, log } = build(() => []);
            await expect(
                service.validateSkillIds('org-1', ['skill-archived']),
            ).rejects.toThrow(/skill-archived/);
            expect(log[0].sql).toContain('archived_at IS NULL');
        });

        it('de-duplicates the input before querying', async () => {
            const { service, log } = build(() => [{ id: 'skill-1' }]);
            await service.validateSkillIds('org-1', ['skill-1', 'skill-1']);
            expect(log[0].params[0]).toEqual(['skill-1']);
        });
    });
});
