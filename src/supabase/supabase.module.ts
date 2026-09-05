import { Module, Global } from '@nestjs/common';
import { SupabaseProvider } from './supabase.provider';

@Global()
@Module({
    providers: [SupabaseProvider],
    exports: [SupabaseProvider],
})
export class SupabaseModule {}
