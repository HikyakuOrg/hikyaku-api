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
 * The successor to TasksModule. What used to be a clock — a five-minute tick
 * checking whether it was 2am somewhere, and a thirty-second tick asking whether
 * the queue had anything — becomes an event pipeline: assignment runs inside the
 * request that creates the package, and the follow-up solve is woken by a
 * NOTIFY rather than polled for.
 *
 * The queue survives that change (durability and retry are not things
 * LISTEN/NOTIFY can provide); the schedule does not.
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
    exports: [
        QueueService,
        AssignmentService,
        ShiftPlanWriter,
        PgNotifyService,
        // Only so the outgoing nightly consumer can hand a replan over. Drops
        // out of the exports with TasksModule.
        ReplanWorker,
    ],
})
export class DispatchModule { }
