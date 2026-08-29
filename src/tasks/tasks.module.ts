import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { VroomModule } from '../vroom/vroom.module';
import { SchedulerRun } from 'src/entities/scheduler-run.entity';
import { OptimisationRun } from 'src/entities/optimisation-run.entity';
import { TasksService } from './tasks.service';

/**
 * The nightly scheduler, on its way out.
 *
 * Everything durable it owned -- the queue, its consumer, the solve -- has moved
 * to DispatchModule. What is left is the clock: the 2am-local check and the boot
 * catch-up, kept only until ASSIGNMENT_MODE flips to `instant` on staging. This
 * module is deleted in the same commit as the crons.
 */
@Module({
    imports: [
        DatabaseModule,
        DispatchModule,
        VroomModule,
        TypeOrmModule.forFeature([SchedulerRun, OptimisationRun]),
    ],
    providers: [TasksService],
})
export class TasksModule { }
