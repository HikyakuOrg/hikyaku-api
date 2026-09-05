import {
    AGING_HOURS,
    chooseBest,
    cheapestPosition,
    effectiveDeadline,
    estimateLeg,
    GREY_BAND,
    haversineMeters,
    isEvictable,
    isGreyBand,
    legKey,
    LOAD_SPREAD_SECONDS_PER_STOP,
    loadPenaltySeconds,
    MAX_EVICTIONS,
    MAX_STOPS,
    pickVictims,
    scheduleArrivals,
    SHIFT_WINDOW_SECONDS,
    TIME_PER_STOP,
    tryInsert,
    type CandidateShift,
    type IncomingPackage,
    type InsertionContext,
    type InsertionResult,
    type InsertionSuccess,
    type RouteStop,
} from './insertion';

/**
 * Every test places its points on the equator, where a degree of longitude is a
 * flat ~111.195 km. That makes distances arithmetic rather than trigonometry, so
 * a failing assertion says something about the algorithm instead of about
 * spherical geometry.
 */
const DEG_PER_KM = 1 / 111.195;
const DEPOT = { lon: 0, lat: 0 };

/** A point `km` east of the depot. */
function east(km: number): { lon: number; lat: number } {
    return { lon: km * DEG_PER_KM, lat: 0 };
}

/**
 * A point `km` north of the depot. Needed wherever a test has to distinguish
 * insertion positions: on a straight line out and back, several orderings cost
 * exactly the same, so only an off-axis stop makes one position uniquely best.
 */
function north(km: number): { lon: number; lat: number } {
    return { lon: 0, lat: km * DEG_PER_KM };
}

/** Seconds Tier 1 budgets to drive `km`, by its own estimator. */
function driveSeconds(km: number): number {
    return estimateLeg(DEPOT, east(km));
}

const DEPARTURE = Date.parse('2026-09-01T08:00:00Z');
const DAY_END = Date.parse('2026-09-01T23:59:59.999Z');

function ctx(overrides: Partial<InsertionContext> = {}): InsertionContext {
    return {
        nowMs: DEPARTURE,
        shiftDayEndMs: DAY_END,
        ...overrides,
    };
}

function stop(overrides: Partial<RouteStop> & { packageId: string }): RouteStop {
    return {
        lon: 0,
        lat: 0,
        weightG: 1_000,
        deadlineMs: null,
        status: 'ASSIGNED',
        evictionCount: 0,
        createdAtMs: DEPARTURE,
        ...overrides,
    };
}

function shift(overrides: Partial<CandidateShift> = {}): CandidateShift {
    return {
        id: 'shift-a',
        revision: 1,
        driverId: 'driver-1',
        vehicleId: 'vehicle-1',
        capacityG: 1_000_000,
        departureMs: DEPARTURE,
        depot: DEPOT,
        stops: [],
        ...overrides,
    };
}

function pkg(overrides: Partial<IncomingPackage> = {}): IncomingPackage {
    return {
        id: 'pkg-new',
        lon: east(5).lon,
        lat: 0,
        weightG: 2_000,
        deadlineMs: null,
        createdAtMs: DEPARTURE,
        evictionCount: 0,
        ...overrides,
    };
}

function expectFeasible(result: ReturnType<typeof tryInsert>): InsertionSuccess {
    if (!result.feasible) {
        throw new Error(`expected a feasible insertion, got "${result.reason}"`);
    }
    return result;
}

describe('haversineMeters', () => {
    it('is zero for a point against itself', () => {
        expect(haversineMeters(DEPOT, DEPOT)).toBe(0);
    });

    it('measures a degree of longitude at the equator', () => {
        expect(haversineMeters(DEPOT, { lon: 1, lat: 0 })).toBeCloseTo(111_195, -2);
    });

    it('is symmetric', () => {
        const a = { lon: 12.5, lat: -37.8 };
        const b = { lon: 13.1, lat: -37.2 };
        expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
    });
});

describe('estimateLeg', () => {
    it('inflates the crow-flies distance for detour and safety', () => {
        const metres = haversineMeters(DEPOT, east(10));
        // 1.35 detour, 11.1 m/s, 1.2 safety.
        expect(estimateLeg(DEPOT, east(10))).toBeCloseTo(
            (metres * 1.35) / 11.1 * 1.2,
            6,
        );
    });

    it('prefers a measured leg over the estimate', () => {
        const measured = { [legKey(DEPOT, east(10))]: 42 };
        expect(estimateLeg(DEPOT, east(10), measured)).toBe(42);
    });

    it('falls back to the estimate for a leg the router did not cover', () => {
        const measured = { [legKey(DEPOT, east(99))]: 42 };
        expect(estimateLeg(DEPOT, east(10), measured)).toBeGreaterThan(100);
    });
});

describe('effectiveDeadline', () => {
    it('passes through a deadline inside the service day', () => {
        expect(effectiveDeadline(DEPARTURE + 3_600_000, DAY_END)).toBe(
            DEPARTURE + 3_600_000,
        );
    });

    it('treats a deadline beyond the service day as no deadline', () => {
        // This is what makes tomorrow's freight evictable today.
        expect(effectiveDeadline(DAY_END + 1, DAY_END)).toBeNull();
    });

    it('keeps null as null', () => {
        expect(effectiveDeadline(null, DAY_END)).toBeNull();
    });
});

describe('tryInsert gates', () => {
    it('rejects on mass before doing any timing work', () => {
        const result = tryInsert(
            shift({ capacityG: 5_000, stops: [stop({ packageId: 'a', weightG: 4_000 })] }),
            pkg({ weightG: 2_000 }),
            ctx(),
        );
        expect(result).toEqual({ feasible: false, shiftId: 'shift-a', reason: 'weight' });
    });

    it('accepts a package that exactly fills the remaining capacity', () => {
        const result = tryInsert(
            shift({ capacityG: 6_000, stops: [stop({ packageId: 'a', weightG: 4_000 })] }),
            pkg({ weightG: 2_000 }),
            ctx(),
        );
        expect(result.feasible).toBe(true);
    });

    it('rejects once the route is at MAX_STOPS', () => {
        const stops = Array.from({ length: MAX_STOPS }, (_, i) =>
            stop({ packageId: `p-${i}`, weightG: 1 }),
        );
        const result = tryInsert(shift({ stops }), pkg({ weightG: 1 }), ctx());
        expect(result).toEqual({
            feasible: false,
            shiftId: 'shift-a',
            reason: 'max_stops',
        });
    });

    it('accepts the stop that brings the route up to MAX_STOPS', () => {
        const stops = Array.from({ length: MAX_STOPS - 1 }, (_, i) =>
            stop({ packageId: `p-${i}`, weightG: 1 }),
        );
        const result = tryInsert(
            // Every stop sits on the depot, so only the stop-count gate is in play.
            shift({ stops }),
            pkg({ weightG: 1, lon: 0, lat: 0 }),
            ctx(),
        );
        expect(result.feasible).toBe(true);
    });

    it('rejects a package that cannot be reached inside the 12h window', () => {
        // Two 200 km legs at ~146 s/km is over 16 hours of driving alone.
        const result = tryInsert(shift(), pkg({ lon: east(200).lon }), ctx());
        expect(result).toEqual({
            feasible: false,
            shiftId: 'shift-a',
            reason: 'window',
        });
    });

    it('is capacity-feasible but time-infeasible when only the window binds', () => {
        const far = shift({ capacityG: 10_000_000 });
        expect(tryInsert(far, pkg({ lon: east(200).lon, weightG: 1 }), ctx())).toEqual({
            feasible: false,
            shiftId: 'shift-a',
            reason: 'window',
        });
    });
});

describe('cheapestPosition', () => {
    it('splices a stop into the middle rather than appending it', () => {
        // Depot — 5 km — 10 km. A package at 7 km belongs between them; appending
        // it would mean driving out to 10, back to 7, then home.
        const existing = shift({
            stops: [
                stop({ packageId: 'near', ...east(5) }),
                stop({ packageId: 'far', ...east(10) }),
            ],
        });
        const result = expectFeasible(
            cheapestPosition(existing, pkg({ lon: east(7).lon }), ctx()),
        );
        expect(result.index).toBe(1);
        expect(result.order).toEqual(['near', 'pkg-new', 'far']);
    });

    it('appends when the package is nowhere near the existing run', () => {
        // Two stops due north, the new one 20 km due east. Visiting it last costs
        // one long leg; slotting it anywhere earlier costs two.
        const existing = shift({
            stops: [
                stop({ packageId: 'near', ...north(2) }),
                stop({ packageId: 'mid', ...north(4) }),
            ],
        });
        const result = expectFeasible(
            cheapestPosition(existing, pkg({ lon: east(20).lon }), ctx()),
        );
        expect(result.index).toBe(2);
        expect(result.order).toEqual(['near', 'mid', 'pkg-new']);
    });

    it('prices the detour, not the whole route', () => {
        // A stop exactly on top of an existing one is free to serve.
        const existing = shift({ stops: [stop({ packageId: 'near', ...east(5) })] });
        const result = expectFeasible(
            cheapestPosition(existing, pkg({ lon: east(5).lon }), ctx()),
        );
        expect(result.deltaSeconds).toBeCloseTo(0, 6);
    });

    it('refuses a position that would push a LATER stop past its own deadline', () => {
        // "far" is promised for just after the drive out to 10 km. Putting the new
        // package in front of it adds a service stop plus a detour, and breaks the
        // promise — so position 0 must lose to position 1, which leaves "far"
        // exactly where it was.
        const farDeadline = DEPARTURE + (driveSeconds(10) + 60) * 1000;
        const existing = shift({
            stops: [stop({ packageId: 'far', ...east(10), deadlineMs: farDeadline })],
        });

        const result = expectFeasible(
            cheapestPosition(existing, pkg({ lon: east(5).lon }), ctx()),
        );
        expect(result.index).toBe(1);
        expect(result.order).toEqual(['far', 'pkg-new']);
    });

    it('rejects outright when two deadlines each demand to go first', () => {
        // Both promised at the earliest either could be reached: whichever is
        // served second is late, at every position.
        const tight = DEPARTURE + (driveSeconds(10) + 30) * 1000;
        const existing = shift({
            stops: [stop({ packageId: 'far', ...east(10), deadlineMs: tight })],
        });

        const result = cheapestPosition(
            existing,
            pkg({ lon: east(10).lon, deadlineMs: tight }),
            ctx(),
        );
        expect(result).toEqual({
            feasible: false,
            shiftId: 'shift-a',
            reason: 'deadline',
        });
    });

    it('ignores a deadline that falls beyond the service day', () => {
        const tomorrow = DAY_END + 3_600_000;
        const existing = shift({
            stops: [stop({ packageId: 'far', ...east(10), deadlineMs: tomorrow })],
        });
        // Inserting in front of "far" would breach `tomorrow` if it were binding.
        const result = expectFeasible(
            cheapestPosition(existing, pkg({ lon: east(1).lon }), ctx()),
        );
        expect(result.index).toBe(0);
    });

    it('reports arrivals that include service time at earlier stops', () => {
        // The deadline pins "first" to the front; on a bare two-stop route both
        // orders cost the same and the assertion would be about tie-breaking
        // rather than about arrival arithmetic.
        const existing = shift({
            stops: [
                stop({
                    packageId: 'first',
                    ...east(4),
                    deadlineMs: DEPARTURE + (driveSeconds(4) + 120) * 1000,
                }),
            ],
        });
        const result = expectFeasible(
            cheapestPosition(existing, pkg({ lon: east(8).lon }), ctx()),
        );
        expect(result.order).toEqual(['first', 'pkg-new']);

        const firstArrival = DEPARTURE + driveSeconds(4) * 1000;
        expect(result.arrivalsMs[0]).toBeCloseTo(firstArrival, -2);
        // Second stop: first arrival + 15 min of service + the 4 km hop.
        expect(result.arrivalsMs[1]).toBeCloseTo(
            firstArrival + (TIME_PER_STOP + driveSeconds(4)) * 1000,
            -2,
        );
    });
});

describe('grey band', () => {
    it('flags an insertion whose slack is a thin fraction of the promise', () => {
        // Reachable in ~44 min, promised at 45 — roughly 2% slack.
        const deadline = DEPARTURE + driveSeconds(5) * 1000 + 60_000;
        const result = expectFeasible(
            tryInsert(shift(), pkg({ deadlineMs: deadline }), ctx()),
        );
        expect(result.slackRatio).toBeLessThan(GREY_BAND);
        expect(isGreyBand(result)).toBe(true);
    });

    it('does not flag a route with no binding deadline at all', () => {
        const result = expectFeasible(tryInsert(shift(), pkg(), ctx()));
        expect(result.slackRatio).toBe(Number.POSITIVE_INFINITY);
        expect(isGreyBand(result)).toBe(false);
    });

    it('does not flag a comfortable deadline', () => {
        const deadline = DEPARTURE + 8 * 3_600_000;
        const result = expectFeasible(
            tryInsert(shift(), pkg({ deadlineMs: deadline }), ctx()),
        );
        expect(isGreyBand(result)).toBe(false);
    });

    it('never flags a rejection', () => {
        expect(isGreyBand({ feasible: false, shiftId: 'x', reason: 'weight' })).toBe(
            false,
        );
    });

    it('lets a measured leg rescue an estimate that just missed', () => {
        // The estimate says 5 km takes ~658 s and the promise is 600 s away, so
        // the haversine guess rejects it. The road is genuinely faster.
        const deadline = DEPARTURE + 600_000;
        const candidate = shift();
        const target = pkg({ deadlineMs: deadline });

        expect(tryInsert(candidate, target, ctx()).feasible).toBe(false);

        const measured = {
            [legKey(DEPOT, east(5))]: 300,
            [legKey(east(5), DEPOT)]: 300,
        };
        expect(tryInsert(candidate, target, ctx({ measuredLegs: measured })).feasible).toBe(
            true,
        );
    });
});

describe('chooseBest', () => {
    const success = (
        shiftId: string,
        deltaSeconds: number,
    ): InsertionSuccess => ({
        feasible: true,
        shiftId,
        index: 0,
        deltaSeconds,
        slackRatio: Number.POSITIVE_INFINITY,
        arrivalsMs: [DEPARTURE],
        order: ['pkg-new'],
    });

    it('returns null when nothing is feasible', () => {
        expect(
            chooseBest([{ feasible: false, shiftId: 'a', reason: 'weight' }], {}),
        ).toBeNull();
    });

    it('prefers the cheapest detour', () => {
        const best = chooseBest([success('a', 900), success('b', 120)], { a: 1, b: 1 });
        expect(best?.shiftId).toBe('b');
    });

    // This case used to assert the bug itself: on an equal detour the FULLER
    // shift won, which is how one van ends up with the whole metro. Same
    // inputs, opposite expectation, and it is now the penalty rather than the
    // tie-break that decides it (300 + 480 against 300 + 2160).
    it('sends an equal-cost package to the emptier shift', () => {
        const best = chooseBest([success('a', 300), success('b', 300)], { a: 2, b: 9 });
        expect(best?.shiftId).toBe('a');
    });

    // The headline case: an otherwise-tied insertion should prefer whichever
    // shift has fewer stops.
    it('prefers a 2-stop shift over a 15-stop one at equal detour cost', () => {
        const best = chooseBest([success('full', 600), success('light', 600)], {
            full: 15,
            light: 2,
        });
        expect(best?.shiftId).toBe('light');
    });

    it('still picks the fuller shift when it is genuinely much closer', () => {
        // 20 stops and a 100 s detour (4900 s all in) against an empty van that
        // would drive 5000 s to serve it. The penalty is a preference, not a
        // rule: sending a van across town to keep the counts level is worse for
        // everybody.
        const best = chooseBest([success('full', 100), success('empty', 5_000)], {
            full: 20,
            empty: 0,
        });
        expect(best?.shiftId).toBe('full');
    });

    it('breaks a full tie on id, so the choice is reproducible', () => {
        const best = chooseBest([success('b', 300), success('a', 300)], { a: 4, b: 4 });
        expect(best?.shiftId).toBe('a');
    });

    // The requirement being asserted is that a missing key counts as an empty
    // shift, and that is preserved. Only the winner flips, for the same reason
    // as the case above: 'a' is the one with no stops.
    it('treats a shift with no recorded stop count as empty', () => {
        const best = chooseBest([success('a', 300), success('b', 300)], { b: 1 });
        expect(best?.shiftId).toBe('a');
    });

    describe('with load spreading switched off', () => {
        it('goes back to comparing raw detour seconds', () => {
            // The kill switch AssignmentService.loadSpread feeds. A 9-stop shift
            // 60 s closer wins again, which is what LOAD_SPREAD_ENABLED=false
            // exists to restore.
            const best = chooseBest([success('a', 300), success('b', 240)], { a: 0, b: 9 }, {
                spreadLoad: false,
            });
            expect(best?.shiftId).toBe('b');
        });

        it('still breaks an exact tie towards the emptier shift', () => {
            // The tie-break flip is not gated. It fires only on exact equality of
            // detour seconds and can never open a shift, so it carries none of
            // the billing risk the penalty does.
            const best = chooseBest([success('a', 300), success('b', 300)], { a: 2, b: 9 }, {
                spreadLoad: false,
            });
            expect(best?.shiftId).toBe('a');
        });
    });
});

describe('loadPenaltySeconds', () => {
    it('charges an empty shift nothing', () => {
        expect(loadPenaltySeconds(0)).toBe(0);
    });

    it('grows smoothly and without a cliff, one step per stop', () => {
        const steps = Array.from({ length: MAX_STOPS + 1 }, (_, i) =>
            loadPenaltySeconds(i),
        );
        for (let i = 1; i < steps.length; i++) {
            expect(steps[i] - steps[i - 1]).toBe(LOAD_SPREAD_SECONDS_PER_STOP);
        }
    });

    it('only ever compares as a difference, so level vans cancel out', () => {
        expect(loadPenaltySeconds(12) - loadPenaltySeconds(12)).toBe(0);
        expect(loadPenaltySeconds(12) - loadPenaltySeconds(9)).toBe(
            3 * LOAD_SPREAD_SECONDS_PER_STOP,
        );
    });

    it('is worth a quarter of the driving window once a van is saturated', () => {
        // Which is more than any single detour a 12h day can hold, so a full van
        // is only ever chosen when it is the only feasible one.
        expect(loadPenaltySeconds(MAX_STOPS)).toBeGreaterThanOrEqual(
            SHIFT_WINDOW_SECONDS / 4,
        );
    });

    it('treats a negative count as empty rather than paying a bonus', () => {
        expect(loadPenaltySeconds(-3)).toBe(0);
    });
});

describe('isEvictable', () => {
    const base = { packageId: 'victim', ...east(5) };

    it('accepts a fresh, deadline-less, never-bumped assigned package', () => {
        expect(isEvictable(stop(base), ctx())).toBe(true);
    });

    it.each([
        ['IN_TRANSIT', 'the driver is already carrying it'],
        ['ONBOARD', 'it is physically loaded'],
        ['DELIVERED', 'it is done'],
        ['PENDING', 'it is not on a route to begin with'],
    ])('refuses a package in %s (%s)', (status) => {
        expect(isEvictable(stop({ ...base, status }), ctx())).toBe(false);
    });

    it('refuses a package with a deadline binding today', () => {
        expect(
            isEvictable(stop({ ...base, deadlineMs: DEPARTURE + 3_600_000 }), ctx()),
        ).toBe(false);
    });

    it('allows a package whose deadline is beyond the service day', () => {
        expect(isEvictable(stop({ ...base, deadlineMs: DAY_END + 1 }), ctx())).toBe(true);
    });

    it('pins a package that has already been bumped MAX_EVICTIONS times', () => {
        expect(
            isEvictable(stop({ ...base, evictionCount: MAX_EVICTIONS }), ctx()),
        ).toBe(false);
        expect(
            isEvictable(stop({ ...base, evictionCount: MAX_EVICTIONS - 1 }), ctx()),
        ).toBe(true);
    });

    it('pins a package that has already waited AGING_HOURS', () => {
        const old = DEPARTURE - AGING_HOURS * 3_600_000 - 1;
        expect(isEvictable(stop({ ...base, createdAtMs: old }), ctx())).toBe(false);
    });
});

describe('pickVictims', () => {
    const incoming = () =>
        pkg({ lon: east(5).lon, deadlineMs: DEPARTURE + 6 * 3_600_000, weightG: 5_000 });

    it('refuses to evict for a package with no promise of its own', () => {
        const full = shift({
            capacityG: 6_000,
            stops: [stop({ packageId: 'victim', ...east(5), weightG: 5_000 })],
        });
        expect(pickVictims(full, pkg({ weightG: 5_000 }), ctx())).toBeNull();
    });

    it('refuses to evict for a package whose deadline is not binding today', () => {
        const full = shift({
            capacityG: 6_000,
            stops: [stop({ packageId: 'victim', ...east(5), weightG: 5_000 })],
        });
        const tomorrow = pkg({ weightG: 5_000, deadlineMs: DAY_END + 1 });
        expect(pickVictims(full, tomorrow, ctx())).toBeNull();
    });

    it('returns null when nothing on the route may be bumped', () => {
        const full = shift({
            capacityG: 6_000,
            stops: [
                stop({
                    packageId: 'protected',
                    ...east(5),
                    weightG: 5_000,
                    deadlineMs: DEPARTURE + 3_600_000,
                }),
            ],
        });
        expect(pickVictims(full, incoming(), ctx())).toBeNull();
    });

    it('bumps exactly one package when one is enough', () => {
        const full = shift({
            capacityG: 10_000,
            stops: [
                stop({ packageId: 'a', ...east(4), weightG: 5_000 }),
                stop({ packageId: 'b', ...east(6), weightG: 4_000 }),
            ],
        });
        const plan = pickVictims(full, incoming(), ctx());
        expect(plan?.victimIds).toHaveLength(1);
        expect(plan?.insertion.feasible).toBe(true);
    });

    it('takes the newest first — an older package has already paid its wait', () => {
        const full = shift({
            capacityG: 10_000,
            stops: [
                stop({
                    packageId: 'old',
                    ...east(4),
                    weightG: 4_000,
                    createdAtMs: DEPARTURE - 10 * 3_600_000,
                }),
                stop({
                    packageId: 'new',
                    ...east(6),
                    weightG: 4_000,
                    createdAtMs: DEPARTURE - 60_000,
                }),
            ],
        });
        const plan = pickVictims(full, incoming(), ctx());
        expect(plan?.victimIds).toEqual(['new']);
    });

    it('prefers the least-bumped package over the newest one', () => {
        const full = shift({
            capacityG: 10_000,
            stops: [
                stop({
                    packageId: 'bumped-once',
                    ...east(4),
                    weightG: 4_000,
                    evictionCount: 1,
                    createdAtMs: DEPARTURE - 60_000,
                }),
                stop({
                    packageId: 'never-bumped',
                    ...east(6),
                    weightG: 4_000,
                    evictionCount: 0,
                    createdAtMs: DEPARTURE - 10 * 3_600_000,
                }),
            ],
        });
        const plan = pickVictims(full, incoming(), ctx());
        expect(plan?.victimIds).toEqual(['never-bumped']);
    });

    it('takes a second victim only when the first is not enough', () => {
        const full = shift({
            capacityG: 12_000,
            stops: [
                stop({ packageId: 'a', ...east(4), weightG: 4_000, createdAtMs: DEPARTURE - 1 }),
                stop({ packageId: 'b', ...east(5), weightG: 4_000, createdAtMs: DEPARTURE - 2 }),
                stop({ packageId: 'c', ...east(6), weightG: 4_000, createdAtMs: DEPARTURE - 3 }),
            ],
        });
        const plan = pickVictims(full, pkg({ weightG: 8_000, deadlineMs: DEPARTURE + 6 * 3_600_000 }), ctx());
        expect(plan?.victimIds).toEqual(['a', 'b']);
    });

    it('gives up rather than emptying the route when even that will not do', () => {
        const full = shift({
            capacityG: 8_000,
            stops: [stop({ packageId: 'a', ...east(4), weightG: 4_000 })],
        });
        const enormous = pkg({
            weightG: 9_000,
            deadlineMs: DEPARTURE + 6 * 3_600_000,
        });
        expect(pickVictims(full, enormous, ctx())).toBeNull();
    });

    it('is deterministic when two candidates are identical but for their id', () => {
        const common = { weightG: 4_000, createdAtMs: DEPARTURE, evictionCount: 0 };
        const full = shift({
            capacityG: 10_000,
            stops: [
                stop({ packageId: 'zzz', ...east(4), ...common }),
                stop({ packageId: 'aaa', ...east(6), ...common }),
            ],
        });
        expect(pickVictims(full, incoming(), ctx())?.victimIds).toEqual(['aaa']);
    });
});

describe('the shift window', () => {
    it('is twelve hours', () => {
        expect(SHIFT_WINDOW_SECONDS).toBe(12 * 60 * 60);
    });

    it('bounds the route including the return leg to the depot', () => {
        // Six stops, each 30 km further out: the drive home is what tips it over.
        const stops = Array.from({ length: 6 }, (_, i) =>
            stop({ packageId: `p-${i}`, ...east(30 * (i + 1)), weightG: 1 }),
        );
        const result = tryInsert(
            shift({ stops, capacityG: 10_000_000 }),
            pkg({ lon: east(1).lon, weightG: 1 }),
            ctx(),
        );
        expect(result.feasible).toBe(false);
    });
});

describe('scheduleArrivals', () => {
    it('returns nothing for an empty route', () => {
        expect(scheduleArrivals(DEPOT, DEPARTURE, [])).toEqual([]);
    });

    it('walks a fixed order, adding service time between stops', () => {
        const arrivals = scheduleArrivals(DEPOT, DEPARTURE, [east(4), east(8)]);
        expect(arrivals[0]).toBeCloseTo(DEPARTURE + driveSeconds(4) * 1000, -2);
        expect(arrivals[1]).toBeCloseTo(
            arrivals[0] + (TIME_PER_STOP + driveSeconds(4)) * 1000,
            -2,
        );
    });

    it('honours measured legs, so a rewrite after a removal uses real numbers when it has them', () => {
        const measured = { [legKey(DEPOT, east(4))]: 120 };
        const arrivals = scheduleArrivals(DEPOT, DEPARTURE, [east(4)], measured);
        expect(arrivals[0]).toBe(DEPARTURE + 120_000);
    });
});

/**
 * One synthetic day, end to end: a warehouse, 30 packages scattered over a
 * metro, three vans, and nothing but the comparator deciding where each parcel
 * lands. This is the scenario the load-spreading penalty exists for, and the
 * source of the before/after numbers quoted on LOAD_SPREAD_SECONDS_PER_STOP.
 *
 * Synthetic on purpose: there is no historical delivery data to replay, so the
 * geography is a deterministic pseudo-random scatter rather than real traffic.
 * A 10 km metro around a shared depot is the shape the reported symptom came
 * from, a town dense enough that every van could plausibly serve every package,
 * which is exactly when a bin-packer has nothing to stop it loading the first
 * one until it is full.
 *
 * Measured here, on this fixture:
 *
 *   comparator                       stops per van   straight-line km
 *   before (fuller shift wins)       30 / 0 / 0      97.0
 *   tie-break flipped, no penalty    30 / 0 / 0      97.0
 *   after (penalty at 240 s/stop)    11 / 11 / 8    114.1
 *
 * The middle row is the point of the second test below: flipping the tie-break
 * changes nothing on its own, because it needs an exact equality of float
 * detour seconds to fire and that essentially never happens.
 */
describe('a synthetic metro day', () => {
    const PACKAGE_COUNT = 30;
    const SHIFT_COUNT = 3;
    const METRO_RADIUS_KM = 10;
    const SEED = 7;

    /**
     * A fixed linear congruential generator. The scenario has to be the same
     * scenario every run for the numbers above to mean anything, so this is
     * seeded rather than fuzzed.
     */
    function scatter(seed: number): IncomingPackage[] {
        let state = seed >>> 0;
        const next = (): number => {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state / 4294967296;
        };
        return Array.from({ length: PACKAGE_COUNT }, (_, i) => {
            const x = (next() * 2 - 1) * METRO_RADIUS_KM;
            const y = (next() * 2 - 1) * METRO_RADIUS_KM;
            return pkg({
                id: `pkg-${String(i).padStart(2, '0')}`,
                lon: x * DEG_PER_KM,
                lat: y * DEG_PER_KM,
                weightG: 2_000,
            });
        });
    }

    type Comparator = (
        results: readonly InsertionResult[],
        stopCounts: Readonly<Record<string, number>>,
    ) => InsertionSuccess | null;

    /**
     * The comparator exactly as it stood before the load-spreading change:
     * cheapest detour, then the FULLER shift, then the id. It lives here and
     * nowhere else, purely to produce the "before" half of the table above.
     */
    const legacy: Comparator = (results, stopCounts) => {
        const feasible = results.filter((r): r is InsertionSuccess => r.feasible);
        if (feasible.length === 0) return null;
        return feasible.reduce((best, candidate) => {
            if (candidate.deltaSeconds !== best.deltaSeconds) {
                return candidate.deltaSeconds < best.deltaSeconds ? candidate : best;
            }
            const candidateStops = stopCounts[candidate.shiftId] ?? 0;
            const bestStops = stopCounts[best.shiftId] ?? 0;
            if (candidateStops !== bestStops) {
                return candidateStops > bestStops ? candidate : best;
            }
            return candidate.shiftId < best.shiftId ? candidate : best;
        });
    };

    const spreading: Comparator = (results, counts) =>
        chooseBest(results, counts, { spreadLoad: true });
    const penaltyOff: Comparator = (results, counts) =>
        chooseBest(results, counts, { spreadLoad: false });

    /** Straight-line depot-out-and-back length of a route, in km. */
    function routeKm(candidate: CandidateShift): number {
        let metres = 0;
        let previous = candidate.depot;
        for (const s of candidate.stops) {
            metres += haversineMeters(previous, { lon: s.lon, lat: s.lat });
            previous = { lon: s.lon, lat: s.lat };
        }
        return (metres + haversineMeters(previous, candidate.depot)) / 1000;
    }

    /**
     * Places the day's packages one at a time against the shifts as they stand,
     * which is what AssignmentService.assignMany does. Placing them all at once
     * against the empty fleet would hide the whole effect.
     */
    function runDay(choose: Comparator): { counts: number[]; km: number } {
        const shifts = Array.from({ length: SHIFT_COUNT }, (_, i) =>
            shift({
                id: `shift-${String.fromCharCode(97 + i)}`,
                driverId: `driver-${i}`,
                vehicleId: `vehicle-${i}`,
                stops: [],
            }),
        );

        for (const parcel of scatter(SEED)) {
            const stopCounts: Record<string, number> = {};
            for (const s of shifts) stopCounts[s.id] = s.stops.length;

            const chosen = choose(
                shifts.map((s) => tryInsert(s, parcel, ctx())),
                stopCounts,
            );
            if (!chosen) throw new Error(`${parcel.id} fitted on no shift at all`);

            const target = shifts.find((s) => s.id === chosen.shiftId);
            if (!target) throw new Error(`chose an unknown shift ${chosen.shiftId}`);
            target.stops.splice(
                chosen.index,
                0,
                stop({
                    packageId: parcel.id,
                    lon: parcel.lon,
                    lat: parcel.lat,
                    weightG: parcel.weightG,
                }),
            );
        }

        return {
            counts: shifts.map((s) => s.stops.length),
            km: shifts.reduce((sum, s) => sum + routeKm(s), 0),
        };
    }

    it('used to hand one driver the whole metro and leave two vans empty', () => {
        // The reported symptom, reproduced. Nothing here is infeasible for the
        // other two vans; the comparator simply never chose them.
        expect(runDay(legacy).counts).toEqual([30, 0, 0]);
    });

    it('is not fixed by the flipped tie-break alone', () => {
        // Necessary but not sufficient: an exact tie on float detour seconds is
        // rare enough that the tie-break never gets a turn.
        expect(runDay(penaltyOff).counts).toEqual([30, 0, 0]);
    });

    it('spreads the same day across all three vans', () => {
        const { counts } = runDay(spreading);

        expect(counts.reduce((a, b) => a + b, 0)).toBe(PACKAGE_COUNT);
        // Measured: 11 / 11 / 8. Asserted as a bound rather than an exact
        // triple so that retuning the estimator does not fail this on a stop
        // moving between two already-balanced vans.
        expect(Math.min(...counts)).toBeGreaterThan(0);
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(4);
        // The before/after that matters: 30 was one van's whole day.
        expect(Math.max(...counts)).toBeLessThan(15);
    });

    it('pays for that balance in total driving distance, and says how much', () => {
        const before = runDay(legacy);
        const after = runDay(spreading);

        // Measured: 97.0 km becomes 114.1 km, about 18% further. Three vans
        // leaving the same depot cover more ground than one, and at this load
        // that is the honest cost of the change. It is not a fixed ratio: the
        // same comparator DRIVES LESS at high load, where the bin-packer's one
        // enormous route wastes more than the extra depot legs cost.
        expect(after.km).toBeGreaterThan(before.km);
        expect(after.km / before.km).toBeLessThan(1.3);
    });
});
