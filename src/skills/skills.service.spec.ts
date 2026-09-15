import { BadRequestException } from '@nestjs/common';
import { SkillsService } from './skills.service';

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
    describe('validateSkillIds', () => {
        it('does nothing for an empty list, with no query', async () => {
            const { service, log } = build(() => []);
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
