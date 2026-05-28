import { Module } from '@nestjs/common';
import { OrganisationsModule } from 'src/organisations/organisations.module';
import { ConnectService } from './connect.service';
import { ConnectController } from './connect.controller';

@Module({
    imports: [OrganisationsModule],
    controllers: [ConnectController],
    providers: [ConnectService],
    exports: [ConnectService],
})
export class ConnectModule {}
