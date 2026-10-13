import { BadRequestException } from '@nestjs/common';
import {
    amountFor,
    readCurrencyOptions,
    toStripeCurrencyOptions,
} from './price-amount';

describe('amountFor', () => {
    const item = {
        currency: 'aud',
        amountMinor: 1250,
        currencyOptions: { eur: 800, jpy: 1300 },
    };

    it('returns the main amount for the main currency, in any case', () => {
        expect(amountFor(item, 'aud')).toBe(1250);
        expect(amountFor(item, 'AUD')).toBe(1250);
    });

    it('returns the currency_options amount for another currency', () => {
        expect(amountFor(item, 'EUR')).toBe(800);
        expect(amountFor(item, 'jpy')).toBe(1300);
    });

    it('returns null when the price has no amount in the currency', () => {
        expect(amountFor(item, 'usd')).toBeNull();
    });
});

describe('toStripeCurrencyOptions', () => {
    it('converts major amounts per currency exponent', () => {
        expect(
            toStripeCurrencyOptions('aud', [
                { currency: 'EUR', amountMajor: 8 },
                { currency: 'jpy', amountMajor: 1300 },
                { currency: 'kwd', amountMajor: 1.234 },
            ]),
        ).toEqual({
            eur: { unit_amount: 800 },
            jpy: { unit_amount: 1300 },
            kwd: { unit_amount: 1230 },
        });
    });

    it('rejects the main currency', () => {
        expect(() =>
            toStripeCurrencyOptions('aud', [
                { currency: 'AUD', amountMajor: 1 },
            ]),
        ).toThrow(BadRequestException);
    });

    it('rejects a currency listed twice', () => {
        expect(() =>
            toStripeCurrencyOptions('aud', [
                { currency: 'eur', amountMajor: 1 },
                { currency: 'EUR', amountMajor: 2 },
            ]),
        ).toThrow(/more than once/);
    });
});

describe('readCurrencyOptions', () => {
    it('drops the main currency and amountless entries', () => {
        expect(
            readCurrencyOptions('aud', {
                aud: { unit_amount: 1250 },
                eur: { unit_amount: 800 },
                usd: { unit_amount: null },
            }),
        ).toEqual({ eur: 800 });
    });

    it('handles a price without currency_options', () => {
        expect(readCurrencyOptions('aud', undefined)).toEqual({});
    });
});
