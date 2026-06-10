/**
 * Normalised routing result returned by the routing endpoint. Mirrors the
 * frontend contract in whendan/app/models/route-preview.ts field-for-field —
 * keep both in sync. The frontend has no knowledge of Valhalla; it only sees
 * this shape.
 */
export interface RouteLeg {
    /** Travel time in seconds. */
    duration: number;
    /** Distance in meters. */
    distance: number;
}

export interface RoutePreview {
    /** Whole-route path as [lng, lat] pairs (legs concatenated, shared boundary points de-duplicated). */
    coordinates: [number, number][];
    /** Index into `coordinates` of each stop; wayPoints[0] = 0, last = coordinates.length - 1. */
    wayPoints: number[];
    /** Per stop-pair legs (n stops → n-1 legs). */
    legs: RouteLeg[];
    summary: {
        /** Total travel time in seconds. */
        duration: number;
        /** Total distance in meters. */
        distance: number;
    };
}
