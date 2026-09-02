import { Module } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { VinController } from './vin.controller';
import { VinService } from './vin.service';

@Module({
    controllers: [VinController],
    providers: [VinService, AuthGuard],
    exports: [VinService],
})
export class VinModule { }
