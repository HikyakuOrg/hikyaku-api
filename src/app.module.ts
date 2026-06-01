
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupabaseModule } from './supabase/supabase.module';
import { OrsModule } from './ors/ors.module';
import { DatabaseModule } from './database/database.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksModule } from './tasks/tasks.module';
import { UsersModule } from './users/users.module';
import { ServiceFeesModule } from './service-fees/service-fees.module';
import { StripeModule } from './stripe/stripe.module';
import { PaymentsModule } from './payments/payments.module';
import { IssuingModule } from './issuing/issuing.module';
import { MailerModule } from './mailer/mailer.module';
import { InvitationsModule } from './invitations/invitations.module';
import { OrganisationsModule } from './organisations/organisations.module';
import { ConnectModule } from './connect/connect.module';
import { CustomersModule } from './customers/customers.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['.env.local', '.env'],
    }),
    SupabaseModule,
    ScheduleModule.forRoot(),
    TasksModule,
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DB_URL,
      autoLoadEntities: true,
    }),
    OrsModule,
    DatabaseModule,
    UsersModule,
    ServiceFeesModule,
    StripeModule,
    PaymentsModule,
    IssuingModule,
    MailerModule,
    InvitationsModule,
    OrganisationsModule,
    ConnectModule,
    CustomersModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule { }
