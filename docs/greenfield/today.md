# Today: current work, not automatic authority

Today collects due work and business context into actionable firm cards. It is a projection of underlying tasks and state, not a place to invent a contact or infer permission from priority. Use the [selling guide](../operations/how-to-sell.md) for the daily research → call → outcome → follow-up → reply flow.

## Sources and rebuilds

`packages/domain/today/` owns build, snapshots, lanes, promotions, actions, snooze and pagination. Source modules create or change their own durable work, then request the supported projection update. A rebuild must preserve work outside its enumerated source scope rather than cancelling unrelated tasks. Firm changes and snapshot updates use the established lock order.

A card may contain research/brief context, a human callback, regular-sequence due work, retained meeting work or CRM commitments/tasks. Actual current source access and authority remain necessary when opening or acting on it. Generated Ask answer/action creation was removed, but retained human tasks, original passages and their deletion/access checks remain.

## Human actions and stops

Calling requires the current dial decision, not just a phone on the card. Logging an outcome changes the underlying work and can stop the old sequence. A human-selected agreed sequence and single-email permission have different enrollment steps; see [sequences](sequences.md). A completed task is not proof that an external contact happened unless the underlying supported action established that event.

Snooze, pause, completion, cancellation and terminal stops are different transitions. The server decides which are legal. Email approval does not remove recipient-local windows, suppression, reply/refusal stops, sender caps or production sending gates. Unknown provider delivery remains uncertain and cannot be turned into a fresh send by rebuilding Today.

## Evidence and privacy

A model-suggested commitment is distinct from human confirmation and verified progress. Coverage gaps and missing replies must be represented honestly. A source deletion or lost assignment must make dependent private content unavailable even if an older card or task reference survives. Do not copy private sources into public task logs.

Existing Today, API, sequence/call/reply and CRM progress tests cover source changes, rebuilds, stale snapshots, snooze, stop propagation and private access. Controlled fixtures do not establish actual callable inventory, delivered follow-up or useful model output. Operational readiness and measured lead supply belong in [current state](../operations/current-state.md).
