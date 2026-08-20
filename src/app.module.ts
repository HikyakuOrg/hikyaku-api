
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryModule, SentryGlobalFilter } from '@sentry/nestjs/setup';
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
import { BillingModule } from './billing/billing.module';
import { ConnectModule } from './connect/connect.module';
import { CustomersModule } from './customers/customers.module';
import { ServicesModule } from './services/services.module';
import { RoutingModule } from './routing/routing.module';
import { OptimisationModule } from './optimisation/optimisation.module';
import { TzdataModule } from './tzdata/tzdata.module';

// Error tracking is opt-in: only wire up Sentry when a DSN is configured.
const sentryEnabled = !!process.env.SENTRY_DSN;

@Module({
  imports: [
    ...(sentryEnabled ? [SentryModule.forRoot()] : []),
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
    BillingModule,
    ConnectModule,
    CustomersModule,
    ServicesModule,
    RoutingModule,
    OptimisationModule,
    TzdataModule,
  ],
  controllers: [],
  providers: [
    ...(sentryEnabled
      ? [{ provide: APP_FILTER, useClass: SentryGlobalFilter }]
      : []),
  ],
})
export class AppModule { }
