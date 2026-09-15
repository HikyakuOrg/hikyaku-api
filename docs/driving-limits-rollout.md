# Turning on driving limits

`DRIVING_LIMITS` makes both dispatch tiers enforce a per-driver cap on working
time, driving time, route distance and stop count. It ships **off**, and this
is how it gets turned on without a driver finding out the hard way that a cap
was picked from intuition rather than from their own history.

Read `src/dispatch/driving-limits.ts`'s class comment first if you have not.
The short version: `driving_limit_profile` rows, linked from `drivers` and
`organisations`, resolve to four independently-nullable limits per driver.
Tier 1 (`src/dispatch/insertion.ts`) gates every automatic insertion against
them; Tier 2 (`src/dispatch/replan.worker.ts` and `src/database/database.service.ts`)
sends the same four numbers to VROOM as hard constraints and refuses to write
back a route that breached one anyway.

## What "off" actually means

Off is not "resolve the limits, then ignore them". With the flag off,
`driving_limit_profile` is not read at all: `driverLimitsOrDefault` and
`driverLimitsOrDefaultForDrivers` (`src/dispatch/driving-limits.ts`) — the two
functions every caller in both tiers goes through — check
`drivingLimitsEnabled()` first and, when it is false, return `NO_LIMITS`
without ever calling `resolveDrivingLimitsForDriver` or its batch form. That
answer is byte-for-byte what the real query returns for a driver with no
profile in an organisation with no default (see `NO_LIMITS`'s own doc
comment, and `driving-limits.spec.ts`'s test for it). So a deploy with the
flag off changes no routing decision, no VROOM request field, and no
persisted route.

Unlike `SERVICE_AREA_MATCHING`, there is no per-package column stamped for
this feature — no `driving_limits_outcome` next to `coverage_outcome`. That
is deliberate scope, not an oversight, but it means the checkable evidence
that "off" held is indirect rather than a query over history: the absence of
any `drive_time` / `distance` / `stop_limit` rejection reason or dispatcher
warning (both are the exact strings `AssignmentService.warningFor` produces,
and neither can appear while every candidate's `limits` is `NO_LIMITS`), and
`GET /api/v1/dispatch/driving-limits/summary` reporting
`drivingLimitsEnabled: false`.

## Step by step

### 1. Deploy with the flag off, and confirm nothing moved

Deploy with `DRIVING_LIMITS` unset or set to anything other than `on`, `true`
or `1`. There is no migration to run here — `driving_limit_profile` and its
foreign keys already exist and are already being written by nothing, since
nothing has shipped that lets an organisation populate them yet outside this
rollout.

Confirm:

- assignment outcomes look like they did the day before: the mix of
  `assigned` versus `assigned_new_shift` unchanged, and in particular **new
  shifts opened per day** — the `dispatch.shift_opened` Sentry counter,
  already in use for the `SERVICE_AREA_MATCHING` rollout — not moving. That
  is the billed number, and it is the same counter for both features because
  opening a shift is the same billed insert regardless of which gate pushed
  a package to it.
- `GET /api/v1/dispatch/driving-limits/summary` returns
  `drivingLimitsEnabled: false`. `shiftCount` and `distribution` still
  populate normally — those describe realised history and do not depend on
  the flag — but nothing in `breachingShifts` can be attributed to an
  enforced cap, because none is being enforced yet.
- nothing in the logs contains `refusing to write it` (`ReplanWorker`'s
  post-solve guard). With the flag off every shift resolves to `NO_LIMITS`,
  so that branch cannot fire; if it does, the flag is not off.

### 2. A pilot organisation looks at its own history, with the flag still off

`GET /api/v1/dispatch/driving-limits/summary?days=30`, no `max…` parameters.
This is the realised distribution — `distribution.workingSeconds`,
`.drivingSeconds`, `.distanceM`, `.stopCount`, each as `{count, min, p50,
p90, max}` — over whatever shifts actually ran in the last month. A cap
worth defending sits above `p90`, not above `p50`: a limit set at the median
day breaches one day in two before it has done anything except make the
first Monday look like an outage.

`drivingSeconds` is an **estimate**, always — the response says so via
`drivingSecondsIsEstimated: true`. It is elapsed working time minus total
service time, not VROOM's own measured travel time, because
`ShiftPlanWriter.writePlan` — the write path every Tier 1 placement and
every continuous replan uses, which under this codebase's "instant"
assignment mode is effectively every shift — never persists that column. See
`estimateDrivingSeconds`'s doc comment in
`src/dispatch/driving-limits-diagnostics.ts` for the one case (a vehicle
waiting on a delivery window) where the estimate reads slightly high.

Pick one organisation for this, same criteria as the service-area rollout: a
handful of warehouses at most, a dispatcher who will answer questions, and
enough daily volume that a month of history means something.

### 3. The pilot writes profiles, with the flag still off

`driving_limit_profile` rows, and the `drivers.driving_limit_profile_id` /
`organisations.default_driving_limit_profile_id` links to them, are written
by the dashboard through PostgREST under RLS — this API has no write
endpoint for them on purpose (see `DrivingLimitsController`'s class
comment). Writing them changes nothing while the flag is off: they exist,
linked, and unread.

### 4. Check what the configured limits would have done

Same endpoint as step 2, now with the pilot's chosen numbers as query
parameters — `maxWorkingSeconds`, `maxDrivingSeconds`, `maxDistanceM`,
`maxStops`, any subset, in the same units the profile stores them in
(seconds, seconds, metres, count):

```
GET /api/v1/dispatch/driving-limits/summary?days=30&maxDistanceM=200000&maxStops=25
```

`breachingShifts[]` names every realised shift that would have crossed a
proposed cap, on which dimension, by how much (`actual` vs `limit`), and how
many packages sat on the breaching portion of that route
(`affectedStopCount` / `affectedPackageIds` — the trailing stops past the
point the cumulative figure first crosses the cap, which is a proxy for how
much would need re-placing, not a claim about which stops an actual re-solve
would drop). `totalBreachingShifts` is that count on its own.

This is the step that answers the billing question before it costs anything:
every package on an affected portion is a package that, with the flag on,
Tier 1 or Tier 2 pushes to another shift or a new one. If a chosen `maxStops`
would have flagged half the fleet's shifts every day last month, that is
signal to loosen it before switching on, not after.

### 5. Switch on

Set `DRIVING_LIMITS=on` and restart, or set it in the running environment if
your host supports that — `drivingLimitsEnabled()` reads `process.env` per
call, so it takes effect on the next package or replan with no deploy.

**Read "Per organisation, or global?" below before you do this.** The flag
is process-wide.

### 6. Watch for a week

Every day, for the pilot organisation:

- **New shifts opened per day**, the same `dispatch.shift_opened` Sentry
  counter from step 1, split by step. Steps 2 and 4 (`AssignmentService`'s
  own numbering: a new shift for a covering driver, and a new shift for
  anybody) are where a driving-limit rejection lands after Tier 1 fails to
  place a package on an existing shift. If either climbs against its
  pre-rollout baseline, tighter limits are billing the organisation more
  shifts than expected — which is the exact trade `maxStops`/`maxDistanceM`
  make, spelled out in `LOAD_SPREAD_SECONDS_PER_STOP`'s own doc comment for
  the load-spreading case and true here for the same reason. An organisation
  with a card on file is billed overage quietly through
  `enforce_shift_allowance()`; one without a card gets a hard `23514` and the
  displaced packages go `deferred` instead. Neither is visible from inside
  the dispatch engine — this counter is the only place either shows up.
- `GET /api/v1/dispatch/driving-limits/summary?days=1` against the SAME
  proposed numbers now configured, to see whether real days are landing
  close to the caps chosen in step 4. Drift here — real distributions
  creeping past what a month of history suggested — is a staffing or route
  problem showing up before a customer complains about it.
- the logs, for `refusing to write it`. Every deployed VROOM field was
  verified against the live solver during HIK-84 (`max_travel_time`,
  `max_distance` and `max_tasks` all independently caused jobs to drop into
  `unassigned` rather than the cap being violated), so this line is expected
  to stay silent. If it appears, a route came back over a cap despite VROOM
  being asked to respect it — investigate the VROOM build before assuming
  the driver actually got that route, since `ReplanWorker` will have refused
  to persist it and left the shift's previous plan in place.
- **evictions.** A tighter cap can make an existing shift refuse a package
  it used to accept, which can push that package all the way to step 5
  (bump an evictable package from another shift) rather than only opening a
  new one. There is no dedicated counter for this yet; watch
  `package.eviction_count` trending up for the pilot's shifts as an informal
  signal, same as the load-spreading rollout would.

### 7. Only then, wider

Repeat steps 2 through 4 for the next organisation before it matters to
them, which with a process-wide flag means before you have already turned it
on for them.

## Rolling back

Set `DRIVING_LIMITS` to anything other than `on`, `true` or `1`. The next
placement and the next replan both resolve to `NO_LIMITS` again. No
migration to revert and no data to repair: `driving_limit_profile` rows and
their links are simply not read again, and stay exactly as written for the
next attempt.

There is no per-package record of which historical decisions a now-enforced
limit would have changed, the way `coverage_outcome` gives one for service
area matching — the diagnostics endpoint answers that retrospectively, over
a date range, but does not stamp it onto any row. That is not a reason to
hesitate about rolling back; it is a reason to pull the diagnostics summary
for the affected window before you do, if you want a record of what the
flag was doing at the time.

## Per organisation, or global?

**`DRIVING_LIMITS` is process-wide. Turning it on for a pilot organisation
turns it on for every tenant the process serves, at the same instant.**

**Is that acceptable for a first rollout? Yes, on one condition, and it is
narrower than service area matching's: every other organisation must have
neither a driver-level `driving_limit_profile_id` set nor an
organisation-level `default_driving_limit_profile_id` set.** Either one
alone is enough to make a tenant affected — the org-level default resolves
for every driver who has none of their own, so a single accidental default
profile reaches an entire fleet, not just whichever driver was explicitly
linked. An organisation with neither resolves every driver to `NO_LIMITS`,
identical to the flag being off for them specifically.

That condition holds today, because nothing has shipped that writes those
columns for anybody outside this rollout. It stops holding the moment a
second organisation's dashboard user sets an org-level default "just to see
what it does" — from then on, switching the flag on for the pilot silently
enforces that tenant's caps too. So the honest position is the same one the
service-area rollout reached by the same argument:

- The first pilot may run on the process-wide flag.
- Before a **second** organisation has any profile linked, this needs a real
  per-organisation flag.

**A genuinely per-organisation flag is deliberately deferred to its own
change rather than improvised here.** Sketching it, so the deferral is a
decision rather than a gap: a column on `organisations`, something like
`driving_limits_enabled boolean NOT NULL DEFAULT false`, read inside
`driverLimitsOrDefault` / `driverLimitsOrDefaultForDrivers` alongside the env
check they already do (`enabled = envFlagOn && orgColumn`), so the env var
stays a global kill switch layered over it — one lever that stops the
feature everywhere without a database write during an incident. The
remaining work is what makes it a separate change: a migration and an RLS
policy deciding who may flip it, a place in the dashboard to flip it from,
and the diagnostics endpoint reporting the per-org state next to the process
one rather than only the process one.

## Verification still outstanding

Unlike the service-area rollout, the VROOM half of this feature was verified
against the live deployed solver rather than assumed — see HIK-84's ticket
comment for the request/response pairs that confirmed `max_travel_time`,
`max_distance` and `max_tasks` are each honoured independently. What has
**not** been run against a live database or a real month of shift history:

- `GET /api/v1/dispatch/driving-limits/summary`'s query plan under real
  volume. `loadShiftMetrics` correlates two subqueries against
  `vrp_route_step` per realised shift (the 'end' step's arrival, and a job
  count); neither is covered by a `(route_id, type)` index today, only
  `route_id` alone. Fine while a route's own step count is in the tens, which
  it always is — the planner choosing a scan over a handful of rows per
  shift is correct, not a problem — but worth confirming rather than
  assuming once thirty days of one organisation's shifts is the real input
  rather than a unit test's fixture.
- that `refusing to write it` genuinely never fires against the pilot's own
  traffic during the watch week. The unit tests prove the guard rejects a
  route it is handed; they cannot prove the deployed VROOM version stays the
  one HIK-84 tested against.
