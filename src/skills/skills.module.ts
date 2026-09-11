import { Module } from '@nestjs/common';
import { SkillsService } from './skills.service';

/**
 * No controller: the skill catalog is read and written by every client
 * straight through PostgREST, under the RLS policies CreateSkillsSchema
 * declares (`vehicles.update` to write, org membership to read). hikyaku-api
 * held a parallel `/api/v1/skills` CRUD surface until HIK-93 was revisited —
 * it was never a security boundary, since every caller here authenticates
 * with the same Supabase user JWT that PostgREST accepts, so it only
 * duplicated what RLS already enforced.
 *
 * What remains is SkillsService.validateSkillIds, exported so PackagesService
 * can check `skillIds` on package create against the caller's catalog. That
 * one still belongs on this side: package creation is already an API-owned
 * write path, and rejecting an *archived* skill is the single rule RLS does
 * not express.
 */
@Module({
    providers: [SkillsService],
    exports: [SkillsService],
})
export class SkillsModule {}
