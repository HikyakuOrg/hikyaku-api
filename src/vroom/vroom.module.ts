import { Module } from '@nestjs/common';
import { VroomService } from './vroom.service';

@Module({
    providers: [VroomService],
    exports: [VroomService],
})
export class VroomModule { }
