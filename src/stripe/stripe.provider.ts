import Stripe from 'stripe';

export const STRIPE_CLIENT = 'STRIPE_CLIENT';

/**
 * Instance type of the Stripe client. Derived via InstanceType to sidestep the
 * stripe SDK's package-root typings, which expose a callable `StripeConstructor`
 * but keep the `Stripe.Checkout`/`Stripe.Event` namespace on an internal module
 * that doesn't resolve under `module: nodenext`.
 */
export type StripeClient = InstanceType<typeof Stripe>;

/**
 * Stripe client singleton. The API key must be a restricted key (`rk_`) with
 * only the permissions this service needs (Checkout Sessions write,
 * PaymentIntents read) — never a full secret key, and never client-side.
 *
 * `apiVersion` is intentionally not overridden: the installed SDK is pinned to,
 * built against, and typed for its own API version. Moving API versions is done
 * by upgrading the `stripe` package, not by passing a newer string the SDK's
 * types don't know about.
 */
export const StripeProvider = {
    provide: STRIPE_CLIENT,
    useFactory: (): StripeClient => {
        const apiKey = process.env.STRIPE_API_KEY;
        if (!apiKey) {
            throw new Error('STRIPE_API_KEY is not set');
        }
        return new Stripe(apiKey);
    },
};
