import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { VroomModule } from '../vroom/vroom.module';
import { SchedulerRun } from 'src/entities/scheduler-run.entity';
import { TasksService } from './tasks.service';
import { QueueService } from './queue.service';

@Module({
    imports: [DatabaseModule, VroomModule, TypeOrmModule.forFeature([SchedulerRun])],
    providers: [TasksService, QueueService],
})
export class TasksModule { }