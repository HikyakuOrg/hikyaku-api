import { Module } from '@nestjs/common';
import { TzdataService } from './tzdata.service';
import { TzdataController } from './tzdata.controller';

@Module({
    controllers: [TzdataController],
    providers: [TzdataService],
})
export class TzdataModule {}
