import { Module } from '@nestjs/common';
import { ValhallaService } from './valhalla.service';

@Module({
    providers: [ValhallaService],
    exports: [ValhallaService],
})
export class ValhallaModule { }
