
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
  ],
  controllers: [],
  providers: [],
})
export class AppModule { }
