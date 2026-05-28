import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganisationsModule } from 'src/organisations/organisations.module';
import { ConnectModule } from 'src/connect/connect.module';
import { IssuingCard } from './entities/issuing-card.entity';
import { IssuingService } from './issuing.service';
import { IssuingController } from './issuing.controller';
import { IssuingWebhookController } from './issuing-webhook.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([IssuingCard]),
        OrganisationsModule,
        ConnectModule,
    ],
    controllers: [IssuingController, IssuingWebhookController],
    providers: [IssuingService],
})
export class IssuingModule {}
