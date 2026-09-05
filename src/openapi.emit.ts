import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { buildOpenApiConfig } from './openapi.config';

/**
 * Writes the OpenAPI document to openapi.json at the repo root.
 *
 * The web dashboard and the mobile app both generate their API clients from a
 * spec, and the deployed one lags whatever is on this branch — so the contract
 * is committed here and the clients read it from the sibling checkout. Run this
 * whenever a DTO or a controller decorator changes.
 *
 * `preview: true` builds the module graph without instantiating providers, so
 * this needs no database, no Supabase key and no Stripe key to run.
 */
async function emit(): Promise<void> {
    const app = await NestFactory.create(AppModule, {
        preview: true,
        logger: false,
    });
    const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
    const target = join(__dirname, '..', 'openapi.json');
    writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await app.close();
    const paths = Object.keys(document.paths ?? {}).length;
    const schemas = Object.keys(document.components?.schemas ?? {}).length;
    process.stdout.write(
        `openapi.json written: ${paths} paths, ${schemas} schemas\n`,
    );
}

emit().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
});
