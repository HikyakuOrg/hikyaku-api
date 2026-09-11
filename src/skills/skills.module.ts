import { Module } from '@nestjs/common';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

/**
 * Exported so PackagesService can validate `skillIds` against the caller's
 * catalog without a second round trip through HTTP.
 */
@Module({
    controllers: [SkillsController],
    providers: [SkillsService],
    exports: [SkillsService],
})
export class SkillsModule {}
