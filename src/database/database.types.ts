import type { VroomJob, VroomVehicle } from '../vroom/vroom.types';

/**
 * Raw row shape returned by the unassigned-packages SELECT query.
 * Geometry columns are projected as scalar lon/lat via ST_X / ST_Y.
 */
export interface PackageRow {
  id: string;
  tracking_number: string;
  created_at: string;
  warehouse_id: string | null;
  /** ST_X(w.warehouse_location) */
  warehouse_lon: number | null;
  /** ST_Y(w.warehouse_location) */
  warehouse_lat: number | null;
  /** package_dimensions.weight_kg */
  weight_kg: number | null;
  /** package_delivery_window.scheduled_arrival */
  scheduled_arrival: string | null;
  /** ST_X(c.customer_location) */
  customer_lon: number | null;
  /** ST_Y(c.customer_location) */
  customer_lat: number | null;
}

/**
 * Raw row shape returned by the driver-vehicle-assignment SELECT query.
 */
export interface AssignmentRow {
  driver_id: string;
  vehicle_id: string;
  vehicle_gross_limits: number;
  ors_vehicle_type: string;
  /** ST_X(w.warehouse_location) from the vehicle's warehouse */
  warehouse_lon: number | null;
  /** ST_Y(w.warehouse_location) from the vehicle's warehouse */
  warehouse_lat: number | null;
}

/**
 * Intermediate shape used when batch-inserting vrp_route_step rows.
 * lon/lat are kept separate so they can be passed as individual parameters
 * to ST_SetSRID(ST_Point($lon, $lat), 4326).
 */
export interface StepInsertRow {
  route_id: string;
  step_index: number;
  type: string;
  solution_id: string;
  package_id: string | null;
  lon: number;
  lat: number;
  arrival: number | null;
  duration: number | null;
  setup: number | null;
  service: number | null;
  waiting_time: number | null;
  load: number[] | null;
}

/** Return type of DatabaseService.buildOptimizationRequest. */
export interface BuildResult {
  /** Ready-to-send body for the VROOM solver. */
  request: {
    jobs: VroomJob[];
    vehicles: VroomVehicle[];
  };
  /** Maps numeric vehicle id (used by VROOM) → DB uuid */
  vehicleMap: Record<number, string>;
  /** Maps numeric job id (used by VROOM) → package uuid */
  jobMap: Record<number, string>;
  /** Maps numeric vehicle id → driver uuid */
  driverMap: Record<number, string>;
}
