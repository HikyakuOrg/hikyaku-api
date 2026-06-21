
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dataSourceOptions } from './database/data-source';
import { SupabaseModule } from './supabase/supabase.module';
import { GeocodeModule } from './geocode/geocode.module';
import { DatabaseModule } from './database/database.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksModule } from './tasks/tasks.module';
import { UsersModule } from './users/users.module';
import { StripeModule } from './stripe/stripe.module';
import { PaymentsModule } from './payments/payments.module';
import { IssuingModule } from './issuing/issuing.module';
import { MailerModule } from './mailer/mailer.module';
import { InvitationsModule } from './invitations/invitations.module';
import { OrganisationsModule } from './organisations/organisations.module';
import { ConnectModule } from './connect/connect.module';
import { CustomersModule } from './customers/customers.module';
import { ServicesModule } from './services/services.module';
import { RoutingModule } from './routing/routing.module';
import { OptimisationModule } from './optimisation/optimisation.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['.env.local', '.env'],
    }),
    SupabaseModule,
    ScheduleModule.forRoot(),
    TasksModule,
    // Schema is Supabase-owned: synchronize stays off and migrations are NOT run
    // on boot (both enforced in dataSourceOptions). autoLoadEntities keeps Nest's
    // existing per-module entity discovery. See src/database/data-source.ts.
    TypeOrmModule.forRoot({
      ...dataSourceOptions,
      autoLoadEntities: true,
    }),
    GeocodeModule,
    DatabaseModule,
    UsersModule,
    StripeModule,
    PaymentsModule,
    IssuingModule,
    MailerModule,
    InvitationsModule,
    OrganisationsModule,
    ConnectModule,
    CustomersModule,
    ServicesModule,
    RoutingModule,
    OptimisationModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule { }
