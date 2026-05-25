import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IssuingCardholder } from './entities/issuing-cardholder.entity';
import { IssuingCard } from './entities/issuing-card.entity';
import { IssuingTransaction } from './entities/issuing-transaction.entity';
import { IssuingService } from './issuing.service';
import { IssuingController } from './issuing.controller';
import { IssuingWebhookController } from './issuing-webhook.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            IssuingCardholder,
            IssuingCard,
            IssuingTransaction,
        ]),
    ],
    controllers: [IssuingController, IssuingWebhookController],
    providers: [IssuingService],
})
export class IssuingModule {}
