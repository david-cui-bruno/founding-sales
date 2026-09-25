# g60: calling identities are attested in version one

Lane g60, 25 September 2026. Decides how a calling identity becomes verified, who may
do it, and what a later, stronger verification would change.

## The gap

Specification revision 3, 9.1: "A calling identity is a verified outbound number; in
version one it must be active and owned by the acting salesperson", and "each
salesperson can verify a personal calling number". `authorizeDial`'s second step
(`docs/greenfield/policy.md`) refuses every dial whose identity is not active, verified
and owned by the actor. Migration 0001 made `calling_identities` for this. But nothing
in the tree inserted a row or set one to `verified`: no domain function, no route, no
desktop control, no `fss admin` command. So production's only salesperson could not
place a call from Today, and the restore drill's step 1 dial probe had no subject
(`no_dialable_subject`, lane g59).

Neither the specification nor an earlier decision says *how* a number is verified. The
repository's docs quote 9.1's "verified" and stop there. This document decides it.

## What there is to verify with

Nothing, in this stack. A call is a `tel:` handoff: the Mac opens the URI and the
person's own phone app places the call (`apps/desktop/src/main/dialHandoff.ts`,
`telHandoff.ts`). No FSS process sees the line a call leaves on, and there is no
telephony provider to place a call-back or send a code. Any "verification" that claimed
to measure the number would be claiming something nothing measured.

## Decision

**In version one a calling identity is verified by attestation**: the person states
that this is the number they place their calls from. The row records who made the
statement, how, and when:

* `verified_at` — database time;
* `verified_by_user_id` — the member who attested, a foreign key into
  `workspace_memberships`;
* `verification_method` — `owner_attestation` when the owner attests their own number,
  `admin_attestation` when an admin attests a member's number on their behalf.

This is the same shape as 12.7's sending checklist (`recordAuthenticationChecklist`):
FSS never queries DNS, so the checklist is a person saying they looked, recorded with
who and when, because that is the only evidence there is for a claim nothing in the
process can check. The attestation is the calling-number version of that record.

The two methods are separate values because they are different evidence. An owner's
statement about their own line is the best version one has. An admin's statement about
somebody else's line is weaker, and a later review should be able to tell them apart.
The method is decided by who acts, never by the request body. `attested: true` is
required in the command body so that no client can verify a number without sending
the statement.

On the Mac the statement is a checkbox beside the number, **This is the number I place
my calls from.**, and it starts unticked. The page never ticks it for the person. An
unticked press registers the number unverified.

Migration 0016's `calling_identities_verification_recorded` refuses a `verified` row
that does not name who verified it, how and when. So there is no second way to become
verified, including an `INSERT`. It is `NOT VALID`, so a hand-inserted row that
predates it does not stop the migration, and it is enforced on every write from 0016
on.

## Who may do what

| Act | Who | Refusal otherwise |
|---|---|---|
| Register a number | any active member, for themselves; an admin, for any active member | `admin_only`, `owner_not_member` |
| Attest | the owner (`owner_attestation`), or an admin (`admin_attestation`) | `identity_unknown` |
| Retire | the owner, or an admin | `identity_unknown` |
| List | the caller's own numbers only | — |

A colleague's identity is `identity_unknown`, not "not yours", for the reason a
colleague's Today card is `not_found`: the difference would tell the caller what
exists. Refusals are request refusals in the sense of `g4-dial-refusal-codes.md`. They
are not holds and have no recovery action. Where a word already exists in the dial
vocabulary it is reused (`identity_shared_line_disabled`).

## Null-owner identities stay disabled

9.1 defers the shared line. Nothing here can create a null-owner row, and one written
by hand is refused attestation (`identity_shared_line_disabled` for an admin,
`identity_unknown` for anybody else). `calling_identities_shared_line_disabled`
(migration 0001) is the structural half. When shared-line entitlements exist they will
need their own decision about who may attest a line nobody owns.

## Which number Today dials from

The most recently attested of the owner's verified, enabled numbers
(`currentCallingIdentityId`). An attestation says "this is the number I place my calls
from", so the latest statement is the current answer. A person who moves to a new line
attests it and does not have to retire the old one first. The Today card and the
settings page ask the same function, so they cannot disagree.

## Retirement keeps the row

`disableCallingIdentity` sets `enabled = false` with `disabled_at` and
`disabled_by_user_id`, and leaves the verification columns as they were. `call_logs`
and `dial_tickets` reference the row, and 9.1's "call logging never refuses history" is
also a statement about what that history points at. Attesting a retired number again
re-enables it. The retirement stays in the audit trail.

## What a real verification would change

A later call-back or SMS code, once there is a telephony provider:

* adds a third `verification_method` (for example `callback_code`) and widens the
  CHECK in a forward migration;
* adds a pending state between registration and verification, with a code, an expiry
  and an attempt count. That is a new table or columns, and `verifyCallingIdentity`
  would require a matching code for that method;
* decides what happens to attested rows. The conservative choice is to keep them
  usable and flag them for re-verification, rather than silently disable every
  salesperson's Call button on the release that ships the provider;
* moves `admin_attestation` behind a policy decision. An admin cannot receive a code on
  somebody else's phone, so that method would probably be retired.

Nothing in `authorizeDial` would change: it reads `verification_status` and `enabled`,
and how a row got there is this module's business.

## Where it is

`packages/domain/dial/identities.ts`, migration
`packages/domain/db/migrations/0016_calling_identity_attestation.sql`,
`apps/api/src/routes/callingIdentities.ts`, the Settings screen's "Your calling number"
section (`apps/desktop/src/renderer/settingsView.ts`, `settingsPage.ts`), and the
restore drill's seed, which attests the rehearsal admin's number through the same two
functions (`apps/worker/src/tools/fss/drillEvidence.ts`).

## What this lane does not add

`fss admin calling-identity register --attest`. An operator command that attested a
number would record a statement the person never made, which is the one thing this
design exists to avoid. It would have to impersonate the owner or invent a third
method. David enters his own number on the Mac. The rehearsal's seed uses the domain
functions directly, as it does for every other row it writes.
