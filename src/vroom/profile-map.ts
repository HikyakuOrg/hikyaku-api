/**
 * Maps the ORS-style profile values stored in vehicle_type.ors_vehicle_type
 * (e.g. 'driving-car', 'driving-hgv') to Valhalla costing names. VROOM runs
 * with the Valhalla router, so vehicle profiles must match the costing keys
 * configured under routingServers.valhalla in vroom-conf/config.yml.
 *
 * Also used by ValhallaService.route() — the routing endpoint the frontend
 * calls so it never has to know about Valhalla costing.
 */
export function orsProfileToValhallaCosting(orsType: string): string {
    if (orsType === 'driving-hgv') return 'truck';
    if (orsType.startsWith('cycling-')) return 'bicycle';
    if (orsType.startsWith('foot-') || orsType === 'wheelchair') return 'pedestrian';
    if (orsType === 'public-transport') return 'bus';
    return 'auto'; // driving-car and anything unknown
}
