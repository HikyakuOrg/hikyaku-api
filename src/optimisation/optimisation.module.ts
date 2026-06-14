import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OptimisationRun } from 'src/entities/optimisation-run.entity';
import { OptimisationController } from './optimisation.controller';
import { OptimisationService } from './optimisation.service';

@Module({
    imports: [TypeOrmModule.forFeature([OptimisationRun])],
    controllers: [OptimisationController],
    providers: [OptimisationService],
})
export class OptimisationModule { }
