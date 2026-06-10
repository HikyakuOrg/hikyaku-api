/**
 * Decodes a Google-encoded polyline into `[lng, lat]` pairs. Valhalla encodes
 * route shapes with 6-digit precision (pass `1e6`), not the usual 5.
 */
export function decodePolyline(encoded: string, precision = 1e5): [number, number][] {
    const points: [number, number][] = [];
    const len = encoded.length;
    let index = 0;
    let lat = 0;
    let lng = 0;

    while (index < len) {
        let b = 0;
        let shift = 0;
        let result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dlat = result & 1 ? ~(result >> 1) : result >> 1;
        lat += dlat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dlng = result & 1 ? ~(result >> 1) : result >> 1;
        lng += dlng;

        points.push([lng / precision, lat / precision]);
    }
    return points;
}
