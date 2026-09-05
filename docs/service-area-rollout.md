# Turning on service area matching

`SERVICE_AREA_MATCHING` makes automatic assignment prefer a driver whose drawn
territory covers the delivery address. It ships **off**, and this is how it gets
turned on without finding out the hard way that a customer's map was half drawn.

Read `src/dispatch/assignment.service.ts`'s class comment first if you have not.
The short version: with the flag on, a package goes to the cheapest shift whose
driver covers it; failing that a new shift is opened for an idle driver who
covers it; failing that it falls back to the cheapest shift regardless of
territory, then to a new shift for anybody, then to eviction.

## What "off" actually means

Off is not "ask, then ignore the answer". With the flag off, `service_areas` and
`driver_service_area` are not read at all. The engine synthesizes an answer in
which every driver at the warehouse is a floater (a driver with no territories,
who covers everywhere), which is byte for byte what the real query returns for an
empty `driver_service_area` table, and under it the whole preference order
collapses into "step 1 for whichever shift is cheapest": the engine as it behaved
before territories existed.

So a deploy with the flag off changes no routing decision. The one thing it does
change is that every package placed while it is off records
`package_assignment.coverage_outcome = 'disabled'`, which is what lets the
summary below tell "we have not switched it on yet" apart from "we switched it on
and nothing matched".

## Step by step

### 1. Deploy with the flag off, and confirm nothing moved

Deploy with `SERVICE_AREA_MATCHING` unset or set to anything other than `on`.
Run the migration (`AddAssignmentCoverageOutcome1788829200000`); it adds a
nullable column and a partial index and rewrites no rows.

Confirm:

- assignment outcomes look like they did the day before: the mix of `assigned`
  versus `assigned_new_shift` should be unchanged, and in particular the count of
  new shifts opened per day should not move. That is the billed one.
- `GET /api/v1/dispatch/coverage/summary` returns `serviceAreaMatching: false`
  and, after a day of traffic, a `byOutcome.disabled` count roughly equal to the
  number of packages placed automatically.
- nothing in the logs mentions a coverage fallback. With the flag off there are
  none by construction, so any at all means the flag is not off.

### 2. A pilot organisation draws its map, with the flag still off

Both halves are already shippable from the web dashboard: drawing territories
(`service_areas`) and staffing drivers on them (`driver_service_area`). Neither
needs this flag, and neither changes any routing while it is off. That is the
point of doing it in this order.

Pick one organisation. Ideally one with a handful of warehouses at most, a
dispatcher who will answer questions, and enough daily volume that a week of data
means something.

### 3. Check whether the map is complete enough

`GET /api/v1/dispatch/coverage/summary?days=7`.

The flag is still off, so every package is `disabled` and `coveredRate` is null.
What you are reading at this stage is `liveServiceAreaCount`, plus the per-address
spot checks below. Once the flag is on, `coveredRate` becomes the number to
watch.

Then spot-check real addresses with the diagnostic endpoint, which is **not**
gated by the flag, precisely so it can be used before the flag is flipped:

```
GET /api/v1/dispatch/coverage?packageId=<id>
GET /api/v1/dispatch/coverage?lon=103.851959&lat=1.29027
```

For each one, `drivers[]` says who would be eligible and why (`explicit` means a
territory selects them, `floater` means they simply have no territories). Pick a
dozen addresses spread across the depot's real delivery area, including the awkward
ones: the edge of town, the industrial estate, the address the dispatcher already
knows is a pain. What you are looking for is:

- **`anyAreaCovers: false` on an ordinary address** means a territory is missing
  there. Fix it before turning the flag on: with the flag on those packages take
  the step 3 or 4 fallback, which is not wrong but is not what anybody wanted.
- **an area with `driverCount: 0`** means a territory was drawn and left
  unstaffed. Worse than not drawing it, because the drivers who used to cover it
  as floaters have now been staffed elsewhere and stopped being floaters.
- **every driver coming back as `floater`** means the staffing half was never
  done. Turning the flag on in that state changes nothing at all, which is safe
  but pointless.

### 4. Flip the flag

Set `SERVICE_AREA_MATCHING=on` and restart, or set it in the running environment
if your host supports that: the getter reads `process.env` per call, so it takes
effect on the next package with no deploy.

**Read the per-organisation question below before you do this.** The flag is
process-wide.

### 5. Watch for a week

Every day, for the pilot organisation:

- `GET /api/v1/dispatch/coverage/summary`: `coveredRate` is the headline. Its
  shortfall is the fallback rate. Read it next to `byOutcome`: a high
  `floater` count means the rate is being carried by drivers with no territories
  rather than by the map, which is fine early on and is not progress.
- `byOutcome.fallbackNoCoveringDriver` climbing means territories are missing
  over real addresses. `byOutcome.fallbackNoCoveringCapacity` climbing means the
  territories exist but the drivers staffed on them have no room, which is a
  staffing or a fleet problem rather than a map one.
- the `fallbacks[]` sample names the actual packages. Feed a few back into
  `GET /api/v1/dispatch/coverage?packageId=…` to see which of the two it was.
- **new shifts opened per day**, from the `dispatch.shift_opened` counter in
  Sentry, split by `step`. Step 4 existed before this feature; **step 2 is the new
  spend**. Opening a shift is the only billed insert in the assignment path, and
  step 2 runs ahead of the step that would have put the package on a van that was
  already out. If step 2 is opening shifts every day, the ordering is costing the
  organisation money and that is a conversation to have with them, not a bug.

Sentry also raises a warning when an organisation's fallback rate exceeds 20% over
a one-minute window with at least twenty decisions in it, and only when that
organisation has at least one live territory. An organisation with no territories
is 100% floater by construction and correct; alerting on it would be noise. The
threshold is `FALLBACK_RATE_ALERT_THRESHOLD` in
`src/dispatch/coverage-metrics.service.ts`, picked by argument rather than from
data because there is no data yet; retune it once there are two weeks of real
numbers.

### 6. Only then, wider

Repeat steps 2 and 3 for the next organisation before it matters to them, which
with a process-wide flag means before you have already turned it on for them.

## Rolling back

Set `SERVICE_AREA_MATCHING` to anything other than `on`. The next package placed
goes back to the pre-territory behaviour and records `disabled`. No migration to
revert, no data to repair, and the territories stay drawn for the next attempt.

The one thing rolling back does not undo is packages already delivered by a
driver who would not have got them before. There is no way to undo that and it is
not a reason to hesitate: those packages were delivered.

## Per organisation, or global?

**`SERVICE_AREA_MATCHING` is process-wide. Turning it on for a pilot organisation
turns it on for every tenant the process serves, at the same instant.**

**Is that acceptable for a first rollout? Yes, on one condition: that every other
organisation still has an empty `driver_service_area`.** An organisation that has
drawn no territories has every driver as a floater, every floater covers
everywhere, and the preference order collapses to exactly what it does with the
flag off. Those tenants are genuinely unaffected, not merely unlikely to notice.
That condition holds today, because nothing has shipped that writes those tables
for anybody.

It stops holding the moment a second organisation starts drawing territories, and
that includes an organisation exploring the map UI out of curiosity. From then on,
turning the flag on for the pilot silently turns it on for them too, against a map
they were still drafting. So the honest position is:

- The first pilot may run on the process-wide flag.
- Before a **second** organisation has territory data, this needs a real per-org
  flag.

**Implementing a genuinely per-organisation flag is deliberately deferred to its
own change rather than improvised here.** Sketching it, so the deferral is a
decision rather than a gap: it would be a column on `organisations`, something
like `service_area_matching_enabled boolean NOT NULL DEFAULT false`, read in
`AssignmentService.assignInternal` alongside the coverage lookup it already does
and carried on `AssignmentPlan` next to the existing `serviceAreaMatching` field,
which is already shaped as a per-assignment fact rather than a global for exactly
this reason. The env var would stay as a global kill switch layered over it
(`enabled = envFlagOn && orgColumn`), so there is still one lever that stops the
feature everywhere without a database write during an incident. The work that
makes it a separate change rather than a line of code is the rest of it: the
column needs a migration and an RLS policy deciding who may flip it, the
dashboard needs somewhere to flip it from and a permission to gate that on, the
read would want folding into the warehouse or organisation lookup the assignment
path already performs rather than becoming a third query per package, and the
coverage summary endpoint would need to report the per-org state rather than the
process one. None of that is hard; all of it is a different review.

## Verification still outstanding

Written and tested without a live database. Two things need confirming on the
first real run, and neither can be checked from a unit test:

- that the migration applies cleanly, including the `NOT VALID` / `VALIDATE`
  pair on `package_assignment_coverage_outcome_chk`.
- that the summary's plan uses
  `package_assignment_coverage_outcome_idx` rather than a sequential scan over
  `package_assignment`. A scan while the table is small is the planner being
  right, not a problem; what would be a problem is the index never being
  considered.
