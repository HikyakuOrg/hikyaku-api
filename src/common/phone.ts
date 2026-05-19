/**
 * The `customer` table enforces `customer_phone ~ '^\+[1-9][0-9]{1,14}$'`
 * (E.164). If we let a non-E.164 number reach the fulfillment INSERT, the whole
 * transaction fails AFTER the card was charged — money taken, booking stranded,
 * Stripe retrying forever. So we normalise + validate at the /pay boundary
 * (before creating the Stripe session) and reject early with a 400.
 */
const E164 = /^\+[1-9]\d{1,14}$/;

/** Strip spaces, dashes, parentheses, dots; keep a single leading '+'. */
export function normalizePhone(input: string): string {
    const trimmed = input.trim();
    const hasPlus = trimmed.startsWith('+');
    const digits = trimmed.replace(/\D/g, '');
    return hasPlus ? `+${digits}` : digits;
}

export function isE164(input: string): boolean {
    return E164.test(input);
}

/** Returns a normalised E.164 string or null if it cannot be one. */
export function toE164OrNull(input: string): string | null {
    const normalized = normalizePhone(input);
    return isE164(normalized) ? normalized : null;
}
