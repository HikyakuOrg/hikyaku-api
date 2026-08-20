export const TZDATA_SCHEMA = 'tzdata';
export const TZDATA_TABLE = 'timezone';

/**
 * Pinned to a specific timezone-boundary-builder release rather than resolving
 * "latest" at boot — this runs on every cold start of every instance, and the
 * unauthenticated GitHub API is rate-limited per IP (60/hr), so polling it on
 * every boot is not viable. Bumping to a newer release means updating this,
 * TIMEZONE_BOUNDARY_SHA256 below, and truncating tzdata.timezone — the
 * boot-time import only ever populates an empty table (see TzdataService).
 */
export const TIMEZONE_BOUNDARY_RELEASE = '2026c';
export const TIMEZONE_BOUNDARY_ASSET = 'timezones-1970.geojson.zip';
export const TIMEZONE_BOUNDARY_INNER_FILE = 'combined-1970.json';
export const TIMEZONE_BOUNDARY_URL = `https://github.com/evansiroky/timezone-boundary-builder/releases/download/${TIMEZONE_BOUNDARY_RELEASE}/${TIMEZONE_BOUNDARY_ASSET}`;
export const TIMEZONE_BOUNDARY_SHA256 =
    'c1bd0839c15a94ace5107e84694915fca3ab74907dee7b2ed4e3e5e01acc8f16';

/** Phases the status endpoint / logs report for the boot-time import. */
export const TZDATA_IMPORT_PHASES = [
    'idle',
    'checking',
    'downloading',
    'importing',
    'completed',
    'skipped_already_populated',
    'skipped_locked_elsewhere',
    'failed',
] as const;
export type TzdataImportPhase = (typeof TZDATA_IMPORT_PHASES)[number];

/** Message protocol from tzdata-import.worker.ts back to TzdataService. */
export type TzdataWorkerMessage =
    | { type: 'log'; message: string }
    | { type: 'status'; phase: Extract<TzdataImportPhase, 'downloading' | 'importing' | 'completed' | 'skipped_locked_elsewhere'> };

