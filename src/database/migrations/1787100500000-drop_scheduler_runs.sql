-- Drops the nightly scheduler's bookkeeping table.
--
-- scheduler_runs existed for exactly one purpose: to make "has warehouse X
-- already been optimised for local date Y?" an atomic question, so that the
-- five-minute cron, the thirty-second consumer and the boot catch-up could not
-- all enqueue the same nightly solve. There is no nightly solve any more.
-- Assignment happens inside the request that creates the package, and the
-- follow-up solve is claimed through pgmq's visibility timeout plus a per-shift
-- advisory lock -- both of which are stronger guarantees than this table ever
-- gave, and neither of which needs a row.
--
-- Ship LAST, after the crons are gone. Dropping it while TasksService still runs
-- turns every tick into a "relation does not exist" error, and the failure mode
-- of getting the order wrong is silent: shifts simply stop being planned.
--
-- The run history goes with it. That is accepted -- see the plan's "Accepted"
-- list. What the table recorded (which warehouse ran when, and how many times it
-- was retried) is not something anything reads; optimisation_run, which the
-- dashboard does read, is untouched.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

DROP TABLE IF EXISTS "public"."scheduler_runs";
