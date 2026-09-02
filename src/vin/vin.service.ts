import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { createDecoder, DecodeResult, VINDecoderWrapper } from '@cardog/corgi';

/**
 * Offline VIN decoding via corgi, backed by a bundled NHTSA vPIC snapshot —
 * no outbound network call per decode.
 *
 * The decoder wraps a better-sqlite3 connection and its first `createDecoder()`
 * call decompresses the bundled ~20MB database to `~/.corgi-cache`, so it is
 * opened once here at module init and reused for the life of the process
 * rather than per request.
 */
@Injectable()
export class VinService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(VinService.name);
    private decoder: VINDecoderWrapper | undefined;

    async onModuleInit(): Promise<void> {
        this.decoder = await createDecoder();
        this.logger.log('VIN decoder ready');
    }

    async onModuleDestroy(): Promise<void> {
        await this.decoder?.close();
    }

    /**
     * Decode a VIN. Never throws for a malformed or unrecognised VIN — corgi
     * reports that as `{ valid: false, errors: [...] }` rather than rejecting,
     * so callers can distinguish "this VIN is invalid" from a service failure.
     */
    async decode(vin: string): Promise<DecodeResult> {
        if (!this.decoder) {
            throw new Error('VIN decoder accessed before initialisation');
        }
        return this.decoder.decode(vin.trim().toUpperCase());
    }
}
