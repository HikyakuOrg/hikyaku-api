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
    /**
     * Hard delivery windows as [start, end] epoch-second pairs. Unused for now
     * (deadlines are modelled as priority); kept for a future enhancement.
     */
    time_windows?: [number, number][];
    /**
     * Required skills, as request-scoped small integers (see
     * src/vroom/skill-index.ts) — VROOM's own hard constraint: this job can
     * only route onto a vehicle whose own `skills` is a superset of this
     * array. Omitted or empty means no requirement, matching VROOM's default.
     */
    skills?: number[];
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
    /**
     * Earliest/latest the vehicle may operate, as [start, end] epoch seconds.
     * Used to encode the dispatcher "set off time": start = the vehicle's
     * earliest departure (override, or computed return/entry + 30 min).
     *
     * IMPORTANT: when any time_window is present VROOM reports step.arrival as
     * ABSOLUTE epoch seconds (without it, arrivals are relative-from-0).
     * insertOptimisedRoutes normalises arrivals back to relative seconds.
     */
    time_window?: [number, number];
    /**
     * Skills this vehicle holds, as request-scoped small integers (see
     * src/vroom/skill-index.ts). A job can only route onto a vehicle whose
     * `skills` is a superset of the job's own — VROOM's own hard constraint.
     * Omitted or empty means the vehicle holds no particular skill.
     */
    skills?: number[];
    /**
     * Hard cap on travel time, seconds (VROOM since v1.13.0). Travel only —
     * excludes service, setup, waiting and breaks, so this is NOT the
     * working-time limit; see driving-limits.ts's `vroomVehicleLimits`,
     * which is the one place this distinction is written down.
     */
    max_travel_time?: number;
    /**
     * Hard cap on total route distance, METRES, return leg included (VROOM
     * since v1.14.0). No unit conversion belongs at this boundary — the
     * profile already stores metres.
     */
    max_distance?: number;
    /**
     * Hard cap on task count (VROOM since v1.11.0). A job counts 1; breaks
     * do not count, and this fleet sends none.
     */
    max_tasks?: number;
}

/**
 * Per-request overrides for vroom-express CLI flags. Honoured only when the
 * server was started with `override: true` in vroom-conf/config.yml.
 */
export interface VroomOptions {
    /** Plan mode (-c). MUST be false to run the solver; true only checks a
     *  pre-supplied plan and leaves every job unassigned. */
    c?: boolean;
    /** Add detailed route geometry (-g). */
    g?: boolean;
    /** Exploration level 0..5 (-x). */
    x?: number;
    /** Threads (-t). */
    t?: number;
}

export interface VroomRequest {
    jobs: VroomJob[];
    vehicles: VroomVehicle[];
    options?: VroomOptions;
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
