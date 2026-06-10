import { orsProfileToValhallaCosting } from './profile-map';

describe('orsProfileToValhallaCosting', () => {
    it.each([
        ['driving-car', 'auto'],
        ['driving-hgv', 'truck'],
        ['cycling-regular', 'bicycle'],
        ['cycling-road', 'bicycle'],
        ['cycling-mountain', 'bicycle'],
        ['cycling-electric', 'bicycle'],
        ['foot-walking', 'pedestrian'],
        ['foot-hiking', 'pedestrian'],
        ['wheelchair', 'pedestrian'],
        ['public-transport', 'bus'],
        ['something-unknown', 'auto'],
        ['', 'auto'],
    ])('maps %s → %s', (orsType, costing) => {
        expect(orsProfileToValhallaCosting(orsType)).toBe(costing);
    });
});
