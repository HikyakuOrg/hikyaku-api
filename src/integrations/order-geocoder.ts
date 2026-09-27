import { Injectable } from '@nestjs/common';
import { GeocodeService } from 'src/geocode/geocode.service';
import type { OrderDeliveryAddressDto } from './dto/order-event.dto';

/** How long one Photon lookup may take before it counts as a transient failure. */
const GEOCODE_TIMEOUT_MS = 30_000;

/** Candidates asked of Photon. The first one that passes {@link matches} wins. */
const CANDIDATES = 5;

/** A delivery point, and how sure we are of it. */
export interface GeocodedPoint {
    lon: number;
    lat: number;
    /** 1 for an exact house match, lower for a street-level one. */
    confidence: number;
    /** Stable reference to the matched OSM object, e.g. `osm:N/123`. */
    gid: string | null;
    raw: Record<string, unknown> | null;
}

interface PhotonFeature {
    geometry?: { coordinates?: [number, number] };
    properties?: {
        osm_type?: string;
        osm_id?: number;
        type?: string;
        name?: string;
        housenumber?: string;
        street?: string;
        postcode?: string;
        countrycode?: string;
    };
}

/** The address could not be placed. Not transient: retrying will not help. */
export class UngeocodableAddressError extends Error {}

/**
 * Street-type abbreviations storefronts commonly send, mapped to the word
 * OpenStreetMap spells out. Both sides of a comparison go through this, so
 * "Collins St" and "Collins Street" compare equal.
 */
const STREET_TYPES: Record<string, string> = {
    st: 'street',
    rd: 'road',
    ave: 'avenue',
    av: 'avenue',
    dr: 'drive',
    ct: 'court',
    cres: 'crescent',
    cr: 'crescent',
    pl: 'place',
    ln: 'lane',
    hwy: 'highway',
    pde: 'parade',
    tce: 'terrace',
    bvd: 'boulevard',
    blvd: 'boulevard',
    cct: 'circuit',
    cl: 'close',
    gr: 'grove',
    sq: 'square',
    esp: 'esplanade',
    wy: 'way',
};

function normaliseStreet(street: string): string {
    return street
        .toLowerCase()
        .replace(/[.,']/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => STREET_TYPES[word] ?? word)
        .join(' ');
}

function normaliseToken(value: string | null | undefined): string {
    return (value ?? '').toLowerCase().replace(/\s+/g, '');
}

/**
 * Splits an address line into its house number and street, including the
 * Australian `unit/number` form ("3/45 Smith St"). No leading number means a
 * street-only line, and a house number of null.
 */
export function parseStreetLine(line: string): {
    houseNumber: string | null;
    street: string;
} {
    const trimmed = line.trim();
    const match =
        /^(?:[\w-]+\s*\/\s*)?(\d+[a-z]?(?:-\d+[a-z]?)?)\s+(.+)$/i.exec(trimmed);
    if (!match) return { houseNumber: null, street: trimmed };
    return { houseNumber: match[1], street: match[2] };
}

/**
 * Whether a Photon candidate is actually the address that was asked for.
 *
 * Photon is a fuzzy search engine, not an address validator: asked for
 * "1 Test Street, Melbourne VIC 3000" it will happily return "IELTS Test
 * Centre, 170 Queen Street". A wrong point is worse than no point (a driver
 * goes to the wrong door, and nobody knows), so a candidate only counts when
 * the country, the postcode and the street name all agree, and, for a
 * house-level candidate, the house number too. A street-level candidate is
 * only accepted inside the right postcode, and at lower confidence.
 */
export function matches(
    feature: PhotonFeature,
    address: OrderDeliveryAddressDto,
): { confidence: number } | null {
    const props = feature.properties ?? {};
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) return null;

    if (
        address.country_code &&
        normaliseToken(props.countrycode) !==
            normaliseToken(address.country_code)
    ) {
        return null;
    }
    if (
        address.postcode &&
        normaliseToken(props.postcode) !== normaliseToken(address.postcode)
    ) {
        return null;
    }

    const wanted = parseStreetLine(address.line1 ?? '');
    const wantedStreet = normaliseStreet(wanted.street);

    if (props.type === 'house') {
        if (!props.street || normaliseStreet(props.street) !== wantedStreet) {
            return null;
        }
        if (
            wanted.houseNumber &&
            normaliseToken(props.housenumber) !==
                normaliseToken(wanted.houseNumber)
        ) {
            return null;
        }
        return { confidence: wanted.houseNumber ? 1 : 0.6 };
    }

    if (props.type === 'street') {
        if (!props.name || normaliseStreet(props.name) !== wantedStreet) {
            return null;
        }
        // A street can run for kilometres; only trust its midpoint when the
        // postcode pins it down.
        if (!address.postcode) return null;
        return { confidence: 0.6 };
    }

    return null;
}

/**
 * Forward-geocodes a storefront delivery address through the Photon proxy.
 *
 * Throws {@link UngeocodableAddressError} when Photon answered but nothing it
 * returned is this address, and rethrows anything else (Photon down, timed
 * out, PHOTON_URL unset) as a transient failure for the worker to retry.
 */
@Injectable()
export class OrderGeocoder {
    constructor(private readonly geocode: GeocodeService) {}

    async geocodeAddress(
        address: OrderDeliveryAddressDto,
    ): Promise<GeocodedPoint> {
        if (!address.line1?.trim()) {
            throw new UngeocodableAddressError(
                'The delivery address has no street line.',
            );
        }

        const query = [
            address.line1,
            [
                address.city,
                address.province_code ?? address.province,
                address.postcode,
            ]
                .filter(Boolean)
                .join(' '),
            address.country,
        ]
            .filter(Boolean)
            .join(', ');

        const response = (await this.geocode.get(
            '/api',
            {
                q: query,
                limit: String(CANDIDATES),
                layer: ['house', 'street'],
            },
            AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
        )) as { features?: PhotonFeature[] } | null;

        for (const feature of response?.features ?? []) {
            const match = matches(feature, address);
            if (!match) continue;

            const [lon, lat] = feature.geometry!.coordinates!;
            const props = feature.properties ?? {};
            return {
                lon,
                lat,
                confidence: match.confidence,
                gid:
                    props.osm_type && props.osm_id !== undefined
                        ? `osm:${props.osm_type}/${props.osm_id}`
                        : null,
                raw: feature as Record<string, unknown>,
            };
        }

        throw new UngeocodableAddressError(
            `Could not find "${query}" on the map. Check the address in the storefront, then retry.`,
        );
    }
}
