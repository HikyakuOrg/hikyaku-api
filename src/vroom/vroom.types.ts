// ─── VROOM request ────────────────────────────────────────────────────────────

/**
 * VROOM job (delivery stop).
 */
export interface VroomJob {
    id: number;
    /** Service duration at the stop, in seconds. */
    service?: number;
    /** [lon, lat] coordinates. */
    location?: number[];
    /** Capacity consumed by this job — sent to VROOM in grams. */
    amount?: number[];
    /** Priority 0–100 (default: 0). */
    priority?: number;
}

/**
 * VROOM vehicle.
 */
export interface VroomVehicle {
    id: number;
    /**
     * Routing profile. With VROOM configured for the Valhalla router this must
     * be a Valhalla costing name ('auto', 'truck', 'bicycle', 'pedestrian',
     * 'bus') matching a key under routingServers.valhalla in vroom config.yml.
     */
    profile?: string;
    /** [lon, lat] start coordinates. */
    start?: number[];
    /** [lon, lat] end coordinates. */
    end?: number[];
    capacity?: number[];
}

export interface VroomRequest {
    jobs: VroomJob[];
    vehicles: VroomVehicle[];
}

// ─── VROOM response ───────────────────────────────────────────────────────────

export interface OptimizationViolation {
    cause: string;
    duration?: number;
}

export interface OptimizationRouteStep {
    type: string;
    arrival?: number;
    duration?: number;
    setup?: number;
    service?: number;
    waiting_time?: number;
    violations?: OptimizationViolation[];
    description?: string;
    location?: number[];
    id?: number;
    load?: number;
    distance?: number;
}

export interface OptimizationRoute {
    vehicle: number;
    steps: OptimizationRouteStep[];
    cost?: number;
    service?: number;
    duration?: number;
    waiting_time?: number;
    delivery?: number[];
    pickup?: number[];
    description?: string;
    geometry?: string;
    distance?: number;
    violations?: OptimizationViolation[];
}

export interface OptimizationSummary {
    cost?: number;
    routes?: number;
    unassigned?: number;
    setup?: number;
    service?: number;
    duration?: number;
    waiting_time?: number;
    priority?: number;
    violations?: OptimizationViolation[];
    delivery?: number;
    pickup?: number;
    distance?: number;
}

export interface OptimizationUnassigned {
    id: number;
    location?: number[];
}

export interface OptimizationResponse {
    code: number;
    error?: string;
    summary?: OptimizationSummary;
    unassigned?: OptimizationUnassigned[];
    routes?: OptimizationRoute[];
}
