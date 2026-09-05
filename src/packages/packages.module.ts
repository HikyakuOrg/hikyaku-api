import { Module } from '@nestjs/common';
import { DispatchModule } from 'src/dispatch/dispatch.module';
import { PackagesController } from './packages.controller';
import { PackagesService } from './packages.service';

/**
 * Package creation, and the assignment it triggers.
 *
 * The service is exported because the booking checkout creates packages too:
 * PaymentsService needs to write them on the transaction that marks the payment
 * completed, or a paid booking can end up with no parcel.
 */
@Module({
    imports: [DispatchModule],
    controllers: [PackagesController],
    providers: [PackagesService],
    exports: [PackagesService],
})
export class PackagesModule {}
