import { GeocodeService } from 'src/geocode/geocode.service';
import type { OrderDeliveryAddressDto } from './dto/order-event.dto';
import {
    OrderGeocoder,
    UngeocodableAddressError,
    matches,
    parseStreetLine,
} from './order-geocoder';

const address = (
    overrides: Partial<OrderDeliveryAddressDto> = {},
): OrderDeliveryAddressDto => ({
    line1: '100 Collins St',
    line2: null,
    city: 'Melbourne',
    province: 'Victoria',
    province_code: 'VIC',
    postcode: '3000',
    country: 'Australia',
    country_code: 'AU',
    company: null,
    ...overrides,
});

const house = (props: Record<string, unknown> = {}) => ({
    geometry: { coordinates: [144.97, -37.814] as [number, number] },
    properties: {
        osm_type: 'W',
        osm_id: 66210704,
        type: 'house',
        housenumber: '100',
        street: 'Collins Street',
        postcode: '3000',
        countrycode: 'AU',
        ...props,
    },
});

describe('parseStreetLine', () => {
    it.each([
        ['100 Collins St', '100', 'Collins St'],
        ['3/45 Smith Street', '45', 'Smith Street'],
        ['12A King Rd', '12A', 'King Rd'],
        ['10-12 Queen St', '10-12', 'Queen St'],
        ['Collins Street', null, 'Collins Street'],
    ])('splits %s', (line, houseNumber, street) => {
        expect(parseStreetLine(line)).toEqual({ houseNumber, street });
    });
});

describe('matches', () => {
    it('accepts an exact house match, abbreviations and all', () => {
        expect(matches(house(), address())).toEqual({ confidence: 1 });
    });

    it('rejects a fuzzy hit on a different street (the "1 Test Street" case)', () => {
        const ielts = house({
            name: 'IDP IELTS Test Centre',
            housenumber: '170',
            street: 'Queen Street',
        });
        expect(matches(ielts, address({ line1: '1 Test Street' }))).toBeNull();
    });

    it('rejects the right street with the wrong house number', () => {
        expect(matches(house({ housenumber: '102' }), address())).toBeNull();
    });

    it('rejects a different postcode or country', () => {
        expect(matches(house({ postcode: '3004' }), address())).toBeNull();
        expect(matches(house({ countrycode: 'NZ' }), address())).toBeNull();
    });

    it('accepts a street-level match at lower confidence only with a postcode', () => {
        const street = {
            geometry: { coordinates: [144.97, -37.81] as [number, number] },
            properties: {
                type: 'street',
                name: 'Collins Street',
                postcode: '3000',
                countrycode: 'AU',
            },
        };
        expect(matches(street, address())).toEqual({ confidence: 0.6 });
        expect(matches(street, address({ postcode: null }))).toBeNull();
        expect(
            matches(
                {
                    ...street,
                    properties: {
                        ...street.properties,
                        name: 'Flinders Street',
                    },
                },
                address(),
            ),
        ).toBeNull();
    });

    it('rejects city-level results and features with no coordinates', () => {
        expect(
            matches(
                {
                    geometry: { coordinates: [1, 2] },
                    properties: { type: 'city' },
                },
                address({ postcode: null, country_code: null }),
            ),
        ).toBeNull();
        expect(
            matches({ properties: house().properties }, address()),
        ).toBeNull();
    });

    it('rejects a house result with no street', () => {
        expect(matches(house({ street: undefined }), address())).toBeNull();
    });

    it('gives a street-only line a house match at lower confidence', () => {
        expect(matches(house(), address({ line1: 'Collins Street' }))).toEqual({
            confidence: 0.6,
        });
    });
});

describe('OrderGeocoder', () => {
    let get: jest.Mock<Promise<unknown>, Parameters<GeocodeService['get']>>;
    let geocoder: OrderGeocoder;

    beforeEach(() => {
        get = jest.fn<Promise<unknown>, Parameters<GeocodeService['get']>>();
        geocoder = new OrderGeocoder({ get });
    });

    it('asks Photon for house and street candidates and returns the first real match', async () => {
        get.mockResolvedValue({
            features: [
                house({ housenumber: '170', street: 'Queen Street' }),
                house(),
            ],
        });

        const point = await geocoder.geocodeAddress(address());

        expect(point).toEqual({
            lon: 144.97,
            lat: -37.814,
            confidence: 1,
            gid: 'osm:W/66210704',
            raw: expect.objectContaining({
                geometry: expect.any(Object) as unknown,
            }) as unknown,
        });
        const [path, query, signal] = get.mock.calls[0];
        expect(path).toBe('/api');
        expect(query).toEqual({
            q: '100 Collins St, Melbourne VIC 3000, Australia',
            limit: '5',
            layer: ['house', 'street'],
        });
        expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('leaves gid null when the feature has no OSM reference', async () => {
        get.mockResolvedValue({
            features: [house({ osm_type: undefined, osm_id: undefined })],
        });
        await expect(geocoder.geocodeAddress(address())).resolves.toMatchObject(
            {
                gid: null,
            },
        );
    });

    it('throws UngeocodableAddressError when nothing matches', async () => {
        get.mockResolvedValue({ features: [] });
        await expect(geocoder.geocodeAddress(address())).rejects.toBeInstanceOf(
            UngeocodableAddressError,
        );
    });

    it('throws UngeocodableAddressError without calling Photon when there is no street line', async () => {
        await expect(
            geocoder.geocodeAddress(address({ line1: '  ' })),
        ).rejects.toBeInstanceOf(UngeocodableAddressError);
        expect(get).not.toHaveBeenCalled();
    });

    it('rethrows a Photon failure as-is, so the worker retries it', async () => {
        const down = new Error('connect ECONNREFUSED');
        get.mockRejectedValue(down);
        await expect(geocoder.geocodeAddress(address())).rejects.toBe(down);
    });
});
