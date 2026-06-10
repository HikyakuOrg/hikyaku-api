/** Minimal subset of the Valhalla /route response consumed by this app. */
export interface ValhallaTripSummary {
    /** Travel time in seconds. */
    time: number;
    /** Distance in the requested units (kilometers here). */
    length: number;
}

export interface ValhallaLeg {
    summary: ValhallaTripSummary;
    /** Encoded polyline, 6-digit precision. */
    shape: string;
}

export interface ValhallaRouteResponse {
    trip: {
        legs: ValhallaLeg[];
        summary: ValhallaTripSummary;
        status: number;
        units: string;
    };
}
