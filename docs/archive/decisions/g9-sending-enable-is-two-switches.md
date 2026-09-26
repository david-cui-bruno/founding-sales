# G9: production sending is two switches, ANDed

**Date:** 20 September 2026 · **Lane:** G9 · **Spec:** 16.2, 4.2

Section 16.2: "Production sending remains disabled until all mandatory scenarios for
the affected release class pass, the deployed commit/image digests match the rehearsal
artifacts, and an authenticated admin enables sending."

That is two different actors making two different statements, and the brief for this
lane says both halves out loud: "the switch itself is a flag the release process sets,
the UI shows it" and "the production sending enable switch that only an authenticated
admin can flip after the release gate".

## The decision

Two values, ANDed, and neither alone is sufficient.

* **`ApiOptions.sendingEnabled`** — the deployment flag the release process sets. It
  is the release process's statement that the gate passed *on these image digests*.
* **The `sending_enabled` setting** — an admin's act, through an ordinary
  authenticated admin session with no step-up (section 2's "Admin authentication"
  row). Enabling it requires a `releaseGateReference`, because "an admin clicked yes"
  is not the gate; the schema refuses `enabled: true` with a null reference.

`effectiveSendingEnabled(deploymentFlag, setting)` is the only function that combines
them, it lives in `packages/domain/settings/effective.ts`, and it fails to `false` on
an unreadable setting.

## Why not one

A single deployment flag would mean production sending turns on at deploy time, with
nobody attesting to anything: the release process cannot know whether a person has
looked. A single admin switch would mean an admin can enable sending from an artifact
nobody rehearsed, which is the sentence's first two clauses discarded.

## What the surfaces show

Both, separately, everywhere: `GET /settings` returns `deploymentSendingEnabled` and
`effectiveSendingEnabled`, and `GET /diagnostics` returns all three. An admin who has
enabled sending and still cannot send has to be able to see which half is off, or the
first support question of the release is unanswerable.
