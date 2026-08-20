import { Inject, Injectable, Logger } from '@nestjs/common';
import {
    trialDaysRemaining,
    trialState,
    type TrialState,
} from 'src/common/trial';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import type { Organisation } from 'src/organisations/organisation.entity';

/**
 * The lookup_key of the Stripe Price a company org's trial subscription is
 * created against. Owned by create-stripe-subscriptions.ps1 at the repo root —
 * that script is the source of truth for the catalogue (amount, trial length,
 * currency options); this service only ever resolves the price by this key, so
 * a price replaced there (its trial length or amount changed) takes effect here
 * automatically, without a redeploy.
 */
const ORGANISATION_PRICE_LOOKUP_KEY = 'hikyaku_organisation_monthly';

/**
 * Trial state for one organisation, as the dashboard consumes it.
 *
 * The end date is returned alongside the derived fields rather than instead of
 * them: the sidebar renders the timestamp in the viewer's locale, so it needs the
 * raw instant, while `state` and `daysRemaining` are computed server-side so a
 * client with a skewed clock cannot disagree with the guard about whether the
 * trial is over.
 */
export interface TrialStatus {
    state: TrialState;
    /** ISO 8601, or null when no trial applies. */
    trialEndsAt: string | null;
    /** Whole days left, floored. Null when no trial applies, 0 once past due. */
    daysRemaining: number | null;
}

/**
 * The subset of a Stripe `customer.subscription.*` webhook payload this
 * service needs. Declared locally rather than importing the SDK's wide
 * `Stripe.Subscription` type, matching the pattern already used for Checkout
 * Session events in payments/stripe-webhook.controller.ts.
 */
export interface SubscriptionEventPayload {
    id: string;
    customer: string | { id: string };
    status: string;
    trial_end: number | null;
    metadata: Record<string, string> | null;
}

@Injectable()
export class BillingService {
    private readonly logger = new Logger(BillingService.name);

    constructor(
        private readonly organisations: OrganisationsService,
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
    ) {}

    /**
     * The organisations module owns the table, so the row is read through its
     * service rather than queried here.
     *
     * Every field is derived from a single `new Date()` so a request that lands
     * exactly on the boundary cannot report `expired` with a positive day count.
     */
    async getTrialStatus(organisationId: string): Promise<TrialStatus> {
        const org = await this.ensureSubscription(
            await this.organisations.getOrFail(organisationId),
        );
        const now = new Date();

        return {
            state: trialState(org.subscriptionStatus, org.trialEndsAt, now),
            trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
            daysRemaining: trialDaysRemaining(org.trialEndsAt, now),
        };
    }

    /**
     * Lazily provisions the Stripe customer + trialing subscription for a
     * company org, the first time anyone asks for its trial status — mirrors
     * ConnectService.ensureAccount's lazy-create-on-first-use pattern, so it
     * needs no new "org created" hook even though organisation creation itself
     * happens outside this API (the web app inserts straight into Postgres via
     * PostgREST).
     *
     * A single `subscriptionStatus == null` check both makes this idempotent (a
     * provisioned org has a status) and protects every pre-existing org: the
     * AddOrganisationSubscriptionStatus migration backfilled those to
     * 'grandfathered', so this never silently starts a trial — or worse, blocks
     * access — for an org that was never told it was on one.
     */
    private async ensureSubscription(org: Organisation): Promise<Organisation> {
        if (org.orgType !== 'company' || org.subscriptionStatus != null) {
            return org;
        }

        const prices = await this.stripe.prices.list({
            lookup_keys: [ORGANISATION_PRICE_LOOKUP_KEY],
            active: true,
            limit: 1,
        });
        const price = prices.data[0];
        if (!price) {
            throw new Error(
                `No active Stripe price found for lookup_key "${ORGANISATION_PRICE_LOOKUP_KEY}". ` +
                    'Run create-stripe-subscriptions.ps1 against this Stripe account first.',
            );
        }
        const trialDays = price.recurring?.trial_period_days ?? 0;

        const customer = await this.stripe.customers.create({
            name: org.name,
            metadata: { organisationId: org.id },
        });

        const subscription = await this.stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: price.id }],
            metadata: { organisationId: org.id },
            ...(trialDays > 0
                ? {
                      trial_period_days: trialDays,
                      // No checkout/customer-portal flow exists yet to collect a
                      // card, so a trial that is not converted must resolve to a
                      // clean terminal state on its own — 'cancel' rather than
                      // leaving Stripe to retry-invoice a customer with no
                      // payment method on file.
                      trial_settings: {
                          end_behavior: { missing_payment_method: 'cancel' },
                      },
                  }
                : {}),
        });

        await this.organisations.setSubscription(
            org.id,
            customer.id,
            subscription.id,
        );

        const trialEndsAt = subscription.trial_end
            ? new Date(subscription.trial_end * 1000)
            : null;
        await this.organisations.updateBillingCache(
            org.id,
            trialEndsAt,
            subscription.status,
        );

        this.logger.log(
            `Provisioned Stripe subscription ${subscription.id} for org ${org.id} (status=${subscription.status})`,
        );

        return { ...org, trialEndsAt, subscriptionStatus: subscription.status };
    }

    /**
     * Applies a `customer.subscription.*` webhook event to the cached columns
     * PermissionGuard and getTrialStatus both read. Keyed off the subscription's
     * own metadata (stamped at creation in ensureSubscription) rather than a
     * reverse DB lookup by customer/subscription id, so this cannot race the
     * synchronous write ensureSubscription() makes right after creating the
     * subscription — the very first `customer.subscription.created` event can
     * arrive before that write lands, and still resolve the correct org.
     */
    async syncSubscriptionFromStripe(
        subscription: SubscriptionEventPayload,
    ): Promise<void> {
        const organisationId = subscription.metadata?.organisationId;
        if (!organisationId) {
            this.logger.warn(
                `Ignoring subscription webhook for ${subscription.id}: no organisationId metadata`,
            );
            return;
        }

        const customerId =
            typeof subscription.customer === 'string'
                ? subscription.customer
                : subscription.customer.id;

        await this.organisations.setSubscription(
            organisationId,
            customerId,
            subscription.id,
        );

        const trialEndsAt = subscription.trial_end
            ? new Date(subscription.trial_end * 1000)
            : null;
        await this.organisations.updateBillingCache(
            organisationId,
            trialEndsAt,
            subscription.status,
        );
    }
}
