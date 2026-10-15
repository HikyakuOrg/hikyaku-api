/**
 * The static path's coverage, as the Delivery Customization Function reads it
 * from a shop metafield:
 *
 *   { "v": 1, "w": [ { "id", "la", "ln", "e", "p": [[lng,lat,...]], "b": [[minLng,minLat,maxLng,maxLat]] } ] }
 *
 * One entry per warehouse a live shop location maps to. `e` is the floater
 * rule's "covered everywhere" (or service area matching switched off), from
 * the same tables `coveringDriversForPoints` reads. `p` holds each staffed
 * area's outer rings as flat [lng,lat,...] arrays; `b` holds bounding boxes
 * for areas that didn't fit. Holes are left out, so a hole shows the rate:
 * the Function errs towards offering it, as dispatch's fallback steps do.
 *
 * Shopify caps the metafield at 10 KB. The encoder here is pure; the caller
 * tries ever coarser simplifications until one fits, then bounding boxes.
 */

/** Shopify's limit on a Function input metafield; a larger value isn't returned. */
export const COVERAGE_BUDGET_BYTES = 10_000;

/** One warehouse's coverage before encoding. */
export interface WarehouseCoverage {
    id: string;
    lon: number;
    lat: number;
    everywhere: boolean;
    /** Outer rings, each [[lng, lat], ...] and closed. */
    rings: [number, number][][];
    /** Bounding boxes [minLng, minLat, maxLng, maxLat]. */
    boxes: [number, number, number, number][];
}

export interface CoverageJson {
    v: 1;
    w: {
        id: string;
        la: number;
        ln: number;
        e: boolean;
        p: number[][];
        b: number[][];
    }[];
}

export function encodeCoverage(
    warehouses: readonly WarehouseCoverage[],
    decimals: number,
): CoverageJson {
    const r = (n: number) => roundTo(n, decimals);
    return {
        v: 1,
        w: warehouses.map((w) => ({
            id: w.id,
            la: roundTo(w.lat, 5),
            ln: roundTo(w.lon, 5),
            e: w.everywhere,
            // A warehouse covered everywhere needs no shapes.
            p: w.everywhere
                ? []
                : w.rings.map((ring) => ring.flatMap(([x, y]) => [r(x), r(y)])),
            // Rounded outwards, so rounding never shrinks a box.
            b: w.everywhere
                ? []
                : w.boxes.map(([x0, y0, x1, y1]) => [
                      roundTo(x0, decimals, Math.floor),
                      roundTo(y0, decimals, Math.floor),
                      roundTo(x1, decimals, Math.ceil),
                      roundTo(y1, decimals, Math.ceil),
                  ]),
        })),
    };
}

export function byteLength(json: CoverageJson): number {
    return Buffer.byteLength(JSON.stringify(json), 'utf8');
}

/** Every ring of every warehouse replaced by its bounding box. */
export function toBoundingBoxes(
    warehouses: readonly WarehouseCoverage[],
): WarehouseCoverage[] {
    return warehouses.map((w) => ({
        ...w,
        rings: [],
        boxes: [...w.boxes, ...w.rings.map(ringBox)],
    }));
}

/** One box per warehouse around all its shapes: the last resort. */
export function toOneBoxPerWarehouse(
    warehouses: readonly WarehouseCoverage[],
): WarehouseCoverage[] {
    return toBoundingBoxes(warehouses).map((w) => ({
        ...w,
        boxes: w.boxes.length === 0 ? [] : [mergeBoxes(w.boxes)],
    }));
}

function ringBox(ring: [number, number][]): [number, number, number, number] {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    return [minX, minY, maxX, maxY];
}

function mergeBoxes(
    boxes: [number, number, number, number][],
): [number, number, number, number] {
    return boxes.reduce((a, b) => [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[2], b[2]),
        Math.max(a[3], b[3]),
    ]);
}

function roundTo(
    n: number,
    decimals: number,
    mode: (x: number) => number = Math.round,
): number {
    const f = 10 ** decimals;
    const scaled = n * f;
    // -37.8 * 100 is -3779.9999…; don't let float noise move an edge a step.
    const snapped =
        Math.abs(scaled - Math.round(scaled)) < 1e-6
            ? Math.round(scaled)
            : scaled;
    return mode(snapped) / f;
}
