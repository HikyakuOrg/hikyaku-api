import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OptimisationRun } from 'src/entities/optimisation-run.entity';
import { DatabaseModule } from '../database/database.module';
import { VroomModule } from '../vroom/vroom.module';
import { OptimisationController } from './optimisation.controller';
import { OptimisationService } from './optimisation.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([OptimisationRun]),
        DatabaseModule,
        VroomModule,
    ],
    controllers: [OptimisationController],
    providers: [OptimisationService],
})
export class OptimisationModule { }
