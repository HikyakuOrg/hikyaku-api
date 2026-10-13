import {
    byteLength,
    encodeCoverage,
    toBoundingBoxes,
    toOneBoxPerWarehouse,
    type WarehouseCoverage,
} from './coverage-export';

const SQUARE: [number, number][] = [
    [144.9, -37.9],
    [145.012345, -37.9],
    [145.012345, -37.8],
    [144.9, -37.8],
    [144.9, -37.9],
];

const W: WarehouseCoverage = {
    id: 'wh-1',
    lon: 144.963211,
    lat: -37.814,
    everywhere: false,
    rings: [SQUARE],
    boxes: [],
};

describe('encodeCoverage', () => {
    it('writes the compact shape the Function reads', () => {
        expect(encodeCoverage([W], 3)).toEqual({
            v: 1,
            w: [
                {
                    id: 'wh-1',
                    la: -37.814,
                    ln: 144.96321,
                    e: false,
                    p: [
                        [
                            144.9, -37.9, 145.012, -37.9, 145.012, -37.8, 144.9,
                            -37.8, 144.9, -37.9,
                        ],
                    ],
                    b: [],
                },
            ],
        });
    });

    it('drops shapes for a warehouse covered everywhere', () => {
        const json = encodeCoverage([{ ...W, everywhere: true }], 5);
        expect(json.w[0]).toEqual(
            expect.objectContaining({ e: true, p: [], b: [] }),
        );
    });

    it('rounds boxes outwards', () => {
        const json = encodeCoverage(toBoundingBoxes([W]), 2);
        expect(json.w[0].p).toEqual([]);
        expect(json.w[0].b).toEqual([[144.9, -37.9, 145.02, -37.8]]);
    });
});

describe('bounding box fallback', () => {
    // A circle with enough vertices that no rounding fits it in 10 KB.
    const circle: [number, number][] = Array.from({ length: 2001 }, (_, i) => {
        const a = (i / 2000) * 2 * Math.PI;
        return [145 + 0.1 * Math.cos(a), -37.8 + 0.1 * Math.sin(a)];
    });
    const big: WarehouseCoverage = { ...W, rings: [circle, SQUARE] };

    it('is needed for a polygon too large for the budget', () => {
        expect(byteLength(encodeCoverage([big], 4))).toBeGreaterThan(10_000);
        const boxed = encodeCoverage(toBoundingBoxes([big]), 4);
        expect(byteLength(boxed)).toBeLessThan(10_000);
        expect(boxed.w[0].b).toHaveLength(2);
        const [x0, y0, x1, y1] = boxed.w[0].b[0];
        expect(x0).toBeLessThanOrEqual(144.9);
        expect(y0).toBeLessThanOrEqual(-37.9);
        expect(x1).toBeGreaterThanOrEqual(145.1);
        expect(y1).toBeGreaterThanOrEqual(-37.7);
    });

    it('can merge to one box per warehouse', () => {
        const merged = encodeCoverage(toOneBoxPerWarehouse([big]), 4);
        expect(merged.w[0].b).toEqual([[144.9, -37.9, 145.1, -37.7]]);
    });
});
