import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type Stripe from 'stripe';
import {
    hasVanityUrlEntitlement,
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
 * Metered shift-overage prices, one per org type, both riding the same Stripe
 * Meter (SHIFT_METER_EVENT_NAME). Owned by create-stripe-subscriptions.ps1
 * alongside ORGANISATION_PRICE_LOOKUP_KEY — see its "Shift usage metering"
 * CONFIG block for the actual free allowance / block size / rate.
 */
const PERSONAL_SHIFT_OVERAGE_PRICE_LOOKUP_KEY =
    'hikyaku_personal_shift_overage';
const ORGANISATION_SHIFT_OVERAGE_PRICE_LOOKUP_KEY =
    'hikyaku_organisation_shift_overage';

/** Must match the Meter's event_name created by create-stripe-subscriptions.ps1. */
const SHIFT_METER_EVENT_NAME = 'shift_created';

/**
 * The lookup_key of the Stripe Entitlement Feature gating vanity subdomains,
 * created by create-stripe-subscriptions.ps1 -WithEntitlements (see
 * $OrganisationFeatures) and attached to the hikyaku_organisation product.
 * Only company orgs can hold it — personal orgs never get a vanity_slug at
 * all (see AddOrganisationVanitySlug), so their Stripe customer is never
 * checked for it.
 */
const VANITY_URL_ENTITLEMENT_LOOKUP_KEY = 'vanity_url';

/**
 * Free shift allowance per billing period, by org type. Mirrors the PLACEHOLDER
 * values hardcoded in enforce_shift_allowance() (AddShiftUsageMetering migration)
 * and $PersonalShiftsFree/$OrganisationShiftsFree in create-stripe-subscriptions.ps1
 * — all three must move together, since this copy only drives the read-only usage
 * endpoint (§ getShiftUsageStatus); the DB trigger is what actually enforces it.
 */
const PERSONAL_SHIFTS_FREE = 30;
const ORGANISATION_SHIFTS_FREE = 600;

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
 * Shift usage for one organisation's current billing period, as the dashboard
 * consumes it — read-only mirror of what enforce_shift_allowance() (the DB
 * trigger doing the actual enforcement) is deciding on. Lets the frontend show a
 * usage indicator and explain a block before it happens, the same relationship
 * TrialStatus has to the trial-expiry guard in PermissionGuard.
 */
export interface ShiftUsageStatus {
    shiftsUsedThisPeriod: number;
    freeAllowance: number;
    hasPaymentMethod: boolean;
    /** ISO 8601 — start of next calendar month, when the free allowance resets. */
    periodEnd: string;
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

/**
 * The subset of a `customer.updated` webhook payload this service needs, same
 * declared-locally-not-imported reasoning as SubscriptionEventPayload above.
 * `default_payment_method` comes through as a bare id string on a webhook
 * payload (Stripe does not expand it there) — the `{ id }` shape is only for
 * callers that pass an already-expanded customer object.
 */
export interface CustomerEventPayload {
    id: string;
    metadata: Record<string, string> | null;
    invoice_settings?: {
        default_payment_method: string | { id: string } | null;
    } | null;
}

/**
 * The subset of an `entitlements.active_entitlement_summary.updated` webhook
 * payload this service needs, same declared-locally-not-imported reasoning as
 * the payload types above. Unlike the subscription/customer webhooks, this
 * event carries no `metadata.organisationId` — only the customer id, so the
 * org is resolved via OrganisationsService.findByStripeCustomerId instead.
 */
export interface EntitlementSummaryEventPayload {
    customer: string;
    entitlements: { data: { lookup_key: string }[] };
}

/** Read by the dashboard's Business Information page. */
export interface VanityUrlStatus {
    hasVanityUrlEntitlement: boolean;
}

@Injectable()
export class BillingService {
    private readonly logger = new Logger(BillingService.name);

    constructor(
        private readonly organisations: OrganisationsService,
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        // Only for the stripe.shift_usage_events outbox (§ ShiftUsageReporter) and
        // the vrp_optimization count (§ getShiftUsageStatus) — both internal
        // detail tables with no reason to grow a full entity/repository of their
        // own, same judgment call as OrganisationsService.getAccountsForUser's
        // raw multi-table query.
        @InjectDataSource() private readonly dataSource: DataSource,
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

        const price = await this.resolveActivePrice(
            ORGANISATION_PRICE_LOOKUP_KEY,
        );
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

        // Eager sync so a brand-new trialing org's vanity host works
        // immediately rather than waiting on the first
        // entitlements.active_entitlement_summary.updated webhook.
        await this.syncVanityUrlEntitlementForCustomer(org.id, customer.id);

        this.logger.log(
            `Provisioned Stripe subscription ${subscription.id} for org ${org.id} (status=${subscription.status})`,
        );

        return { ...org, trialEndsAt, subscriptionStatus: subscription.status };
    }

    /** Shared by ensureSubscription and every shift-overage price lookup below. */
    private async resolveActivePrice(lookupKey: string): Promise<Stripe.Price> {
        const prices = await this.stripe.prices.list({
            lookup_keys: [lookupKey],
            active: true,
            limit: 1,
        });
        const price = prices.data[0];
        if (!price) {
            throw new Error(
                `No active Stripe price found for lookup_key "${lookupKey}". ` +
                    'Run create-stripe-subscriptions.ps1 against this Stripe account first.',
            );
        }
        return price;
    }

    /**
     * Creates the Stripe customer + a subscription holding *only* the metered
     * shift-overage item — no trial, no base fee. Covers two cases that both
     * need billing without ever going through the trial flow in
     * ensureSubscription(): personal orgs (which have no Stripe presence at
     * all otherwise), and grandfathered/legacy company orgs, which
     * ensureSubscription() deliberately skips forever (its `subscriptionStatus
     * != null` guard) so they are never silently re-enrolled in a fresh trial.
     */
    private async provisionMeteredOnlyBilling(
        org: Organisation,
        overageLookupKey: string,
    ): Promise<{ customerId: string; subscriptionId: string }> {
        const overagePrice = await this.resolveActivePrice(overageLookupKey);

        const customer = await this.stripe.customers.create({
            name: org.name,
            metadata: { organisationId: org.id },
        });
        const subscription = await this.stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: overagePrice.id }],
            metadata: { organisationId: org.id },
        });

        await this.organisations.setSubscription(
            org.id,
            customer.id,
            subscription.id,
        );

        this.logger.log(
            `Provisioned metered-only Stripe billing for org ${org.id} ` +
                `(customer ${customer.id}, subscription ${subscription.id})`,
        );

        return { customerId: customer.id, subscriptionId: subscription.id };
    }

    /**
     * Ensures an org has a Stripe subscription that includes its shift-overage
     * price, provisioning whatever is missing along the way. Self-healing by
     * design: called from ShiftUsageReporter on a wake-up and from
     * createBillingPortalSession() on demand, so an org that has never been
     * provisioned gets caught up automatically rather than needing its own
     * creation hook. Three cases land here: a personal org's very first shift, a
     * fresh company org whose ensureSubscription() trial call hasn't run yet,
     * and a grandfathered company org that ensureSubscription() will never touch
     * (see provisionMeteredOnlyBilling's docstring) — the first two get a real
     * subscription via ensureSubscription(), the third gets metered-only billing
     * directly, same as a personal org.
     */
    private async ensureShiftOverageSubscriptionItem(
        org: Organisation,
    ): Promise<{ customerId: string }> {
        let sub = await this.organisations.getSubscription(org.id);
        const overageLookupKey =
            org.orgType === 'personal'
                ? PERSONAL_SHIFT_OVERAGE_PRICE_LOOKUP_KEY
                : ORGANISATION_SHIFT_OVERAGE_PRICE_LOOKUP_KEY;

        if (!sub?.stripeSubscriptionId) {
            if (org.orgType === 'company' && org.subscriptionStatus == null) {
                await this.ensureSubscription(org);
                sub = await this.organisations.getSubscription(org.id);
            } else {
                const provisioned = await this.provisionMeteredOnlyBilling(
                    org,
                    overageLookupKey,
                );
                return { customerId: provisioned.customerId };
            }
        }

        if (!sub?.stripeSubscriptionId || !sub.stripeCustomerId) {
            // ensureSubscription() only provisions once org.subscriptionStatus is
            // null (see its own docstring) — if it ran and this is still empty,
            // something upstream is broken; surface it rather than looping.
            throw new Error(
                `Organisation ${org.id} still has no Stripe subscription after provisioning.`,
            );
        }

        const overagePrice = await this.resolveActivePrice(overageLookupKey);

        const items = await this.stripe.subscriptionItems.list({
            subscription: sub.stripeSubscriptionId,
            limit: 100,
        });
        const alreadyAttached = items.data.some(
            (item) => item.price.id === overagePrice.id,
        );
        if (!alreadyAttached) {
            await this.stripe.subscriptionItems.create({
                subscription: sub.stripeSubscriptionId,
                price: overagePrice.id,
            });
            this.logger.log(
                `Attached shift-overage price ${overagePrice.id} to subscription ${sub.stripeSubscriptionId} (org ${org.id})`,
            );
        }

        return { customerId: sub.stripeCustomerId };
    }

    /**
     * Posts one organisation's claimed shifts to the Stripe Billing Meter.
     *
     * Just the Stripe half. Which rows to report, and the claim that stops two
     * replicas reporting the same ones, belong to ShiftUsageReporter -- this used
     * to be an every-minute scheduled job that did the reading, the reporting
     * and the marking with nothing in between, which is exactly how every shift
     * came to be billed once per running replica.
     *
     * `identifier` is Stripe's own idempotency key for meter events: a reporter
     * that posts successfully and then dies before marking the rows reported will
     * re-post the same batch after the stale claim expires, and Stripe counts it
     * once.
     */
    async reportShiftUsageBatch(
        organisationId: string,
        count: number,
        identifier: string,
    ): Promise<void> {
        const org = await this.organisations.getOrFail(organisationId);
        const { customerId } =
            await this.ensureShiftOverageSubscriptionItem(org);

        await this.stripe.billing.meterEvents.create({
            event_name: SHIFT_METER_EVENT_NAME,
            identifier,
            payload: {
                value: String(count),
                stripe_customer_id: customerId,
            },
        });
    }

    /**
     * Shift usage for the dashboard's usage indicator / block-explanation UI.
     * Purely read-only — enforce_shift_allowance() (the DB trigger) is the
     * actual enforcement, this only mirrors what it's deciding on. See
     * ShiftUsageStatus for field meanings.
     */
    async getShiftUsageStatus(
        organisationId: string,
    ): Promise<ShiftUsageStatus> {
        const org = await this.organisations.getOrFail(organisationId);
        const now = new Date();
        const periodEnd = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
        );

        const [{ count }]: { count: number }[] = await this.dataSource.query(
            `SELECT count(*)::int AS count
               FROM public.vrp_optimization
              WHERE organisation_id = $1
                AND created_at >= date_trunc('month', now())`,
            [organisationId],
        );
        const sub = await this.organisations.getSubscription(organisationId);

        return {
            shiftsUsedThisPeriod: count,
            freeAllowance:
                org.orgType === 'personal'
                    ? PERSONAL_SHIFTS_FREE
                    : ORGANISATION_SHIFTS_FREE,
            hasPaymentMethod: sub?.hasPaymentMethod ?? false,
            periodEnd: periodEnd.toISOString(),
        };
    }

    /**
     * Stripe's hosted Billing Portal — the smallest way to let an org add a
     * payment method today, since no Checkout/Elements card-collection flow
     * exists anywhere in the app yet (see the trial's own
     * missing_payment_method comment above). Requires a Billing Portal
     * configuration to exist on the Stripe account (dashboard or API,
     * one-time setup).
     */
    async createBillingPortalSession(
        organisationId: string,
        returnUrl: string,
    ): Promise<{ url: string }> {
        const org = await this.organisations.getOrFail(organisationId);
        const { customerId } =
            await this.ensureShiftOverageSubscriptionItem(org);

        const session = await this.stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });

        return { url: session.url };
    }

    /**
     * Applies a `customer.updated` webhook event to has_payment_method — the
     * column enforce_shift_allowance() reads to decide whether an org past its
     * free shift allowance is blocked or billed as overage. Keyed off the
     * customer's own metadata.organisationId, stamped at creation time in
     * ensureSubscription()/provisionPersonalShiftBilling() above, same
     * race-safety reasoning as syncSubscriptionFromStripe below.
     */
    async syncPaymentMethodFromStripe(
        customer: CustomerEventPayload,
    ): Promise<void> {
        const organisationId = customer.metadata?.organisationId;
        if (!organisationId) {
            this.logger.warn(
                `Ignoring customer.updated webhook for ${customer.id}: no organisationId metadata`,
            );
            return;
        }

        const hasPaymentMethod =
            !!customer.invoice_settings?.default_payment_method;
        await this.organisations.updatePaymentMethodStatus(
            organisationId,
            hasPaymentMethod,
        );
    }

    /**
     * Shared by the eager sync in ensureSubscription() and the webhook
     * handler below. activeEntitlements.list() takes no lookup_key filter
     * (only `customer`), so the match against
     * VANITY_URL_ENTITLEMENT_LOOKUP_KEY happens client-side.
     */
    private async syncVanityUrlEntitlementForCustomer(
        organisationId: string,
        stripeCustomerId: string,
    ): Promise<void> {
        const entitlements =
            await this.stripe.entitlements.activeEntitlements.list({
                customer: stripeCustomerId,
            });
        const hasEntitlement = entitlements.data.some(
            (e) => e.lookup_key === VANITY_URL_ENTITLEMENT_LOOKUP_KEY,
        );
        await this.organisations.updateVanityUrlEntitlement(
            organisationId,
            hasEntitlement,
        );
    }

    /**
     * Applies an `entitlements.active_entitlement_summary.updated` webhook
     * event to has_vanity_url_entitlement — the column
     * get_booking_organisation()/get_tracking_details() read to decide
     * whether a company org's vanity_slug host currently resolves. Keyed off
     * the customer id (this event carries no organisationId metadata, unlike
     * the subscription/customer webhooks), resolved via
     * OrganisationsService.findByStripeCustomerId.
     */
    async syncVanityUrlEntitlementFromStripe(
        payload: EntitlementSummaryEventPayload,
    ): Promise<void> {
        const sub = await this.organisations.findByStripeCustomerId(
            payload.customer,
        );
        if (!sub) {
            this.logger.warn(
                `Ignoring entitlements webhook for customer ${payload.customer}: no matching organisation`,
            );
            return;
        }

        const hasEntitlement = payload.entitlements.data.some(
            (e) => e.lookup_key === VANITY_URL_ENTITLEMENT_LOOKUP_KEY,
        );
        await this.organisations.updateVanityUrlEntitlement(
            sub.organisationId,
            hasEntitlement,
        );
    }

    /**
     * Vanity-URL entitlement state for the Business Information settings
     * page. Combines the cached flag with the grandfathered sentinel via
     * hasVanityUrlEntitlement() — the same decision
     * get_booking_organisation()/get_tracking_details() make in Postgres, so
     * the settings page and the vanity host itself never disagree.
     */
    async getVanityUrlStatus(organisationId: string): Promise<VanityUrlStatus> {
        const org = await this.organisations.getOrFail(organisationId);
        const sub = await this.organisations.getSubscription(organisationId);
        return {
            hasVanityUrlEntitlement: hasVanityUrlEntitlement(
                org.subscriptionStatus,
                sub?.hasVanityUrlEntitlement ?? false,
            ),
        };
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
