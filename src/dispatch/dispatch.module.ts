import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OptimisationRun } from 'src/entities/optimisation-run.entity';
import { DatabaseModule } from 'src/database/database.module';
import { ValhallaModule } from 'src/valhalla/valhalla.module';
import { VroomModule } from 'src/vroom/vroom.module';
import { AssignmentService } from './assignment.service';
import { PgNotifyService } from './pg-notify.service';
import { QueueService } from './queue.service';
import { ReplanWorker } from './replan.worker';
import { ShiftPlanWriter } from './shift-plan.writer';

/**
 * Dispatch: getting a package onto a van.
 *
 * The successor to TasksModule, which no longer exists. What used to be a clock
 * — a five-minute tick checking whether it was 2am somewhere, and a
 * thirty-second tick asking whether the queue had anything — is an event
 * pipeline: assignment runs inside the request that creates the package, and the
 * follow-up solve is woken by a NOTIFY.
 *
 * The queue survives that change, because durability and retry are not things
 * LISTEN/NOTIFY can provide. The schedule does not: there is no scheduled job
 * left anywhere in this codebase, and Nest's scheduling package is no longer a
 * dependency. The single remaining timer is ReplanWorker's sixty-second pgmq
 * sweep, which exists
 * because a NOTIFY fired while the listener is reconnecting reaches nobody —
 * see SWEEP_MS there for why that is a backstop and not a scheduler.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([OptimisationRun]),
        DatabaseModule,
        ValhallaModule,
        VroomModule,
    ],
    providers: [
        QueueService,
        PgNotifyService,
        ShiftPlanWriter,
        AssignmentService,
        ReplanWorker,
    ],
    exports: [QueueService, AssignmentService, ShiftPlanWriter, PgNotifyService],
})
export class DispatchModule { }
