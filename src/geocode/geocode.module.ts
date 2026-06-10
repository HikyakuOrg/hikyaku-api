import { Module } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { GeocodeController } from './geocode.controller';
import { GeocodeService } from './geocode.service';

@Module({
    controllers: [GeocodeController],
    providers: [GeocodeService, AuthGuard],
    exports: [GeocodeService],
})
export class GeocodeModule { }
