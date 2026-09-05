import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OptimisationRun } from 'src/entities/optimisation-run.entity';
import { DispatchModule } from '../dispatch/dispatch.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { OptimisationController } from './optimisation.controller';
import { OptimisationService } from './optimisation.service';

/**
 * The two endpoints that survived the scheduler.
 *
 * Neither owns route persistence any more: the ad-hoc path opens a shift and
 * hands it to the assignment engine, and "re-optimise" enqueues replans for the
 * shifts that already exist. Hence ShiftsModule and DispatchModule where
 * DatabaseModule and VroomModule used to be.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([OptimisationRun]),
        DispatchModule,
        ShiftsModule,
    ],
    controllers: [OptimisationController],
    providers: [OptimisationService],
})
export class OptimisationModule {}
