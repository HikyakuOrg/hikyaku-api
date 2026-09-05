import { Global, Module } from '@nestjs/common';
import { TokenVerifier } from './token-verifier.service';

/**
 * Global, matching SupabaseModule: TokenVerifier's own dependency
 * (SUPABASE_CLIENT) is already global, and AuthGuard/PermissionGuard are
 * themselves resolved ambiently by Nest wherever a controller declares
 * @UseGuards(...) without listing the guard as a local provider — most of
 * their host modules rely on exactly that today. Making this global keeps
 * that working without adding an import to every module that guards a route.
 */
@Global()
@Module({
    providers: [TokenVerifier],
    exports: [TokenVerifier],
})
export class AuthModule {}
