import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { TZDATA_SCHEMA, TZDATA_TABLE, TzdataImportPhase, TzdataWorkerMessage } from './tzdata.constants';
import { TzdataStatusDto } from './dto/tzdata-status.dto';

@Injectable()
export class TzdataService implements OnApplicationBootstrap {
    private readonly logger = new Logger(TzdataService.name);
    private phase: TzdataImportPhase = 'idle';
    private error?: string;
    private updatedAt = new Date();

    constructor(@InjectDataSource() private readonly dataSource: DataSource) { }

    /**
     * Only the population check below is awaited here — a couple of fast
     * queries. The import itself runs in a worker thread that is deliberately
     * never awaited, so a cold tzdata.timezone never delays the app from
     * serving traffic.
     */
    async onApplicationBootstrap(): Promise<void> {
        this.setPhase('checking');

        if (await this.isPopulated()) {
            this.logger.log(`${TZDATA_SCHEMA}.${TZDATA_TABLE} already populated, skipping import.`);
            this.setPhase('skipped_already_populated');
            return;
        }

        this.logger.log(`${TZDATA_SCHEMA}.${TZDATA_TABLE} is empty — starting background import.`);
        this.startImportWorker();
    }

    /** Live check against the database — independent of this instance's own import history. */
    async isPopulated(): Promise<boolean> {
        const tableRows: { exists: boolean }[] = await this.dataSource.query(
            `SELECT EXISTS (
               SELECT 1 FROM information_schema.tables
               WHERE table_schema = $1 AND table_name = $2
             ) AS exists`,
            [TZDATA_SCHEMA, TZDATA_TABLE],
        );
        if (!tableRows[0]?.exists) return false;

        // Only safe to query the table directly once we know it exists above —
        // interpolated because Postgres has no way to parameterise identifiers.
        const rowRows: { exists: boolean }[] = await this.dataSource.query(
            `SELECT EXISTS (SELECT 1 FROM "${TZDATA_SCHEMA}"."${TZDATA_TABLE}") AS exists`,
        );
        return rowRows[0]?.exists ?? false;
    }

    /** Backs GET /api/v1/tzdata/status, combined there with a fresh isPopulated() check. */
    getImportState(): Pick<TzdataStatusDto, 'importState' | 'error' | 'updatedAt'> {
        return { importState: this.phase, error: this.error, updatedAt: this.updatedAt.toISOString() };
    }

    private setPhase(phase: TzdataImportPhase, error?: string): void {
        this.phase = phase;
        this.error = error;
        this.updatedAt = new Date();
    }

    /** Fire-and-forget: intentionally never awaited so boot is never blocked. */
    private startImportWorker(): void {
        const worker = new Worker(join(__dirname, 'tzdata-import.worker.js'));

        worker.on('message', (msg: TzdataWorkerMessage) => {
            if (msg.type === 'log') {
                this.logger.log(`[tzdata-import] ${msg.message}`);
            } else {
                this.setPhase(msg.phase);
            }
        });
        worker.on('error', (err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(
                `Timezone import worker crashed: ${err instanceof Error ? err.stack : message}`,
            );
            this.setPhase('failed', message);
        });
        worker.on('exit', (code) => {
            if (code === 0) {
                this.logger.log('Timezone import worker finished.');
                return;
            }
            this.logger.error(`Timezone import worker exited with code ${code}.`);
            // The 'error' handler above already set 'failed' for a caught
            // exception; this covers exits that skip it entirely (e.g. killed).
            if (this.phase !== 'failed') {
                this.setPhase('failed', `Worker exited with code ${code}.`);
            }
        });
    }
}
