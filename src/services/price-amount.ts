import { BadRequestException } from '@nestjs/common';
import { toStripeMinorUnits } from 'src/common/money';

/** The parts of a catalog price that {@link amountFor} reads. */
export interface PricedItem {
    /** Main currency of the Stripe price, lower-case. */
    currency: string;
    /** `unit_amount` in the main currency, minor units. */
    amountMinor: number;
    /** Extra amounts from the price's `currency_options`, keyed by lower-case
     *  currency, minor units. Never contains the main currency. */
    currencyOptions: Record<string, number>;
}

/**
 * The per-unit amount of `item` in `currency`, in that currency's minor units:
 * the main amount when `currency` is the main currency, else its
 * `currency_options` entry, else null. Never converts between currencies.
 */
export function amountFor(item: PricedItem, currency: string): number | null {
    const code = currency.trim().toLowerCase();
    if (code === item.currency) return item.amountMinor;
    return item.currencyOptions[code] ?? null;
}

/** One extra currency amount as the admin sends it, in major units. */
export interface CurrencyAmountInput {
    currency: string;
    amountMajor: number;
}

/**
 * Validate and convert the admin's extra currency amounts into Stripe's
 * `currency_options` map. Rejects the main currency (it is `amountMajor`) and
 * duplicates.
 */
export function toStripeCurrencyOptions(
    mainCurrency: string,
    inputs: CurrencyAmountInput[],
): Record<string, { unit_amount: number }> {
    const main = mainCurrency.toLowerCase();
    const options: Record<string, { unit_amount: number }> = {};
    for (const input of inputs) {
        const code = input.currency.trim().toLowerCase();
        if (code === main) {
            throw new BadRequestException(
                `currencyOptions must not include the main currency (${code.toUpperCase()}); set amountMajor instead.`,
            );
        }
        if (options[code]) {
            throw new BadRequestException(
                `currencyOptions lists ${code.toUpperCase()} more than once.`,
            );
        }
        options[code] = {
            unit_amount: toStripeMinorUnits(input.amountMajor, code),
        };
    }
    return options;
}

/** Read a Stripe price's `currency_options` into minor amounts, dropping the
 *  main currency (Stripe echoes it there too) and entries without an amount. */
export function readCurrencyOptions(
    mainCurrency: string,
    raw: Record<string, { unit_amount: number | null }> | null | undefined,
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [code, option] of Object.entries(raw ?? {})) {
        const lower = code.toLowerCase();
        if (lower === mainCurrency || option?.unit_amount == null) continue;
        out[lower] = option.unit_amount;
    }
    return out;
}
