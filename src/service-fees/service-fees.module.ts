import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrsModule } from 'src/ors/ors.module';
import { AuthGuard } from 'src/auth/guards/auth.guard';
import { ServiceRate } from './entities/service-rate.entity';
import { ServiceFeesController } from './service-fees.controller';
import { ServiceFeesService } from './service-fees.service';

@Module({
    imports: [TypeOrmModule.forFeature([ServiceRate]), OrsModule],
    controllers: [ServiceFeesController],
    providers: [ServiceFeesService, AuthGuard],
})
export class ServiceFeesModule {}
