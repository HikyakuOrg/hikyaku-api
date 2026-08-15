import { Injectable } from '@nestjs/common';
import {
    trialDaysRemaining,
    trialState,
    type TrialState,
} from 'src/common/trial';
import { OrganisationsService } from 'src/organisations/organisations.service';

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

@Injectable()
export class BillingService {
    constructor(private readonly organisations: OrganisationsService) {}

    /**
     * The organisations module owns the table, so the row is read through its
     * service rather than queried here.
     *
     * Every field is derived from a single `new Date()` so a request that lands
     * exactly on the boundary cannot report `expired` with a positive day count.
     */
    async getTrialStatus(organisationId: string): Promise<TrialStatus> {
        const org = await this.organisations.getOrFail(organisationId);
        const now = new Date();

        return {
            state: trialState(org.trialEndsAt, now),
            trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
            daysRemaining: trialDaysRemaining(org.trialEndsAt, now),
        };
    }
}
