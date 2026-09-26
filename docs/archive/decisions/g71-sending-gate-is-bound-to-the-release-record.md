# g71: the sending gate is bound to the release record

Lane g71, 25 September 2026. This decides how 16.2's "the deployed commit/image
digests match the rehearsal artifacts" becomes a rule the software enforces. It covers
where each process learns its own digest, what happens when it cannot, and which
process compares which half of the record.

## The gap

Specification revision 3, 16.2: "Production sending remains disabled until all
mandatory scenarios for the affected release class pass, the deployed commit/image
digests match the rehearsal artifacts, and an authenticated admin enables sending."
Appendix G 42 restates it as four conditions that must all agree: artifact digest,
rehearsal gate, smoke tests and manual enable.

Before this lane, two of the four were enforced. G12 made the send gate read both
switches, the deployment flag and the admin's `sending_enabled` attestation
(`g12-the-send-gate-reads-both-switches.md`). The attestation's `releaseGateReference`
could be any nonempty string, and nothing compared it with anything.
`rehearsal-release-record.sh` wrote a durable record of a green rehearsal naming both
image digests, and nothing read it. The digest match was section 6, step 2 of
`docs/greenfield/release.md`: an instruction to compare two `describe-task-definition`
outputs by eye. The independent review of `b2cc080b` (section 1, P1 "sending gate";
action 6) named this as a pre-sending blocker.

## Decision

1. **The record is stored.** Migration 0017's `release_records` holds each
   `fss.release-record.v1` whole, keyed by its reference, with the columns the rules
   read beside it and CHECKs that keep the two in agreement. The table is append-only
   for the runtime role. `fss admin release-record put` stores a record, idempotently.
   `release-deploy.sh --release-record` runs the put after the final verify. The
   contract lives in `@fss/contracts` and is strict, and the release suite parses the
   script's real output with it.
2. **The API checks when the admin enables.** Saving `enabled: true` is refused unless
   the reference is a stored record whose suite is `pass` and whose `artifacts.api` is
   the running API's digest. The refusals are `release_record_unknown`,
   `release_record_not_passing`, `release_record_digest_mismatch` and
   `release_record_identity_unknown`. Saving `enabled: false` is always accepted.
3. **The worker checks before every send.** `decideSend` requires the attested record
   to be stored and passing, and its `artifacts.worker` to be the running worker's
   digest. Otherwise it refuses `workspace_sending_not_attested`, with the binding
   refusal as `detail`.
4. **Each process learns its digest from the ECS task metadata endpoint.** It reads it
   once at startup. `FSS_IMAGE_DIGEST` is used only outside ECS, and when neither
   source answers the digest is `unknown`.
5. **Unknown fails closed.** An unknown identity binds to nothing: every enable is
   refused and every send held.

The comparison by eye in section 6 stays. The admin still reads both digests before
attesting, because that is the moment a person takes responsibility for the claim. But
it is no longer the only thing between an unrehearsed image and a prospect.

## Why the metadata endpoint

The digest has to come from somewhere the process cannot be talked out of. Three
sources were available.

- **An environment variable set by Terraform** (`FSS_IMAGE_DIGEST` in the task
  definition). This needs a Terraform change and keeps a second copy of a value the task
  definition already holds, and the two can drift. A task definition that set it wrong,
  or a `run-task --overrides` that set it at all, could claim a rehearsed digest for an
  image nobody rehearsed. That is the one failure this lane exists to prevent.
- **The image itself** (a build argument baked into the image). An image cannot know
  its own manifest digest at build time, because the digest is computed from the
  finished image. A revision label is a commit, not a digest.
- **`ECS_CONTAINER_METADATA_URI_V4`.** ECS injects it into every task on the platform
  version this stack runs, with no IAM permission and no Terraform. A GET of it answers
  this container's metadata. `Image` is the reference the task definition registered,
  and `infra/modules/cluster` refuses any reference that does not end in
  `@sha256:<64 hex>`, so its suffix is exactly the digest the release record names.

The container endpoint is used rather than `/task`. `/task` lists every container in
the task, and choosing ours would take its container name, a second copy of a Terraform
string. `ImageID` is read only when `Image` carries no digest. It can be the local image
configuration digest rather than the registry manifest digest. A value that is wrong in
that way never matches a record, so it fails closed, and `image_digest_source` in the
startup line says which field was used.

Inside ECS the variable is ignored, even when the endpoint fails. That keeps the
override from being a way around the check. Outside ECS (tests, a laptop) there is no
metadata, and the variable is the only way to name an identity.

## Why fail closed

An unknown identity could be treated three ways: allow, warn, or refuse.

- **Allow** makes the rule decorative in exactly the case it cannot see.
- **Warn** does the same, plus a log line.
- **Refuse** costs an enable that says `release_record_identity_unknown` and a held
  send that says the same.

Both refusals are recoverable, visible, and explain themselves in the startup line
(`image_digest_detail`). An automated email to a prospect is none of those things. This
is G12's reasoning about the deployment flag's default, applied to the third fact.

The send gate does not trust that the enable rule ran. An attestation written before
g71, or by hand, is checked at send time exactly as a fresh one is. The attestation
tests reach the gate's refusals by writing the setting row directly.

## Why the API digest at save and the worker digest at send

Each process compares the half of the record that describes itself. It is the only
half it can check against something it knows first-hand.

- The **API** takes the admin's statement, so it checks that statement against the
  image serving the request. The check happens at save, in the command's transaction.
  A check at the route could be walked past by a second caller, and a refusal is only
  useful to the admin while they are still looking at the form.
- The **worker** sends, so the worker checks before every dispatch, against itself.
  That covers the case the save-time check cannot. If a later deploy puts a different
  worker image under an attestation that was valid when it was saved, the worker holds
  every send from its first dispatch. Nobody has to remember to withdraw anything.

Neither check stands in for the other. An API that accepted an enable says nothing
about which worker is running, and a worker that finds a passing record says nothing
about which API took the enable. `GET /settings` and `GET /diagnostics` apply the API
half on read, so after a redeploy the settings page and Home's sidebar say sending is
off. The worker's gate is about to say the same.

## The drill seed

The rehearsal's evidence seed has to produce an accepted send through the real
dispatch path before any release record exists. It already named 16.2's deployment half
itself (`deploymentSendingEnabled: true`), because the recorded Gmail client sends
nowhere. It now names the release identity the same way. It stores a record under its
own reference, with digests that are SHA-256 of a sentence, then enables as that
record's API and dispatches as that record's worker. The real rules run on real rows.

Those digests can never be the digest of a built image, so a drill record that reached
production would bind to no API and no worker. It cannot get there anyway: the command
refuses `FSS_DEPENDENCIES=live`, and its script refuses a production prefix.

## What this gives up

- **The first enable after this merge needs the record stored first.** A production
  admin who attests without it gets `release_record_unknown`. Section 6, step 2 of the
  release runbook says to put it first.
- **An API or worker that cannot read its metadata cannot enable or send.** That is
  the intended trade. It is also the one behaviour here that no cloud run has observed
  yet (release.md 8.0ag, "Still unverified").
- **Records are never replaced.** A rehearsal that produced a wrong record under a
  reference is superseded by a new rehearsal and a new reference, not by an edit.
