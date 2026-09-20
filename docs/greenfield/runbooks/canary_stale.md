# canary_stale

**Metric:** `CanaryCompletionAgeSeconds` · **Severity:** critical · **Spec:** 13.3

## Symptoms

The scheduler-to-worker canary has not completed within five minutes. One row per
workspace per quarter hour is inserted by the scheduler and completed by the worker;
the completion has stopped arriving.

## First checks

1. `GET /diagnostics`: scheduler heartbeat, worker heartbeat, canary age, oldest
   runnable job age.
2. Whether the canary row for the current quarter hour exists at all. An absent row is
   a scheduler fault; a present, uncompleted row is a worker or queue fault.
3. Oldest runnable job age — a canary behind a long queue is a throughput symptom, not
   a liveness one.

## Diagnosis

The canary exists because neither heartbeat can prove the path: a scheduler inserting
jobs nobody claims is alive, a worker with an empty queue is alive, and the system
between them is dead. So a stale canary with both heartbeats fresh is the interesting
case, and it means the queue is not being drained — contention, a starving claim loop,
or a handler registry that refuses the canary kind after a bad deployment.

## Safe recovery

- Work the scheduler or worker alarm if one is firing; the canary follows.
- If both are fresh, look at the claim loop: running-job count, lease ages, and
  `pg_stat_activity`.
- A missed quarter hour is not replayed. The next insert is a new quarter hour and the
  age recovers on its first completion.

## Escalation

Page if the canary is stale with both heartbeats fresh. That combination means
something structural about job execution is wrong and is the case the canary was added
to catch.

## What must stay held

- Do not complete a canary row by hand. The completion is the measurement; writing it
  makes the metric lie and removes the only proof of the path.
- Do not enable sending or release holds on the strength of "the services are up". The
  canary is the evidence that they are connected.
