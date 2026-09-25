# Policy, dialing and call outcomes

Specification revision 3, sections 9.1, 9.2, 10.1 and 15, and Appendices A, D, F and
G 6, 17, 25 and 26. Suppression has its own page: `docs/greenfield/suppression.md`.

## The short version

FSS never authorizes a prohibited call. One server function, `authorizeDial`, decides
allow or refuse, in the eight-step order of section 9.2, at one instant of database
time, and first refusal wins. An allow becomes a one-use ticket that lives sixty
seconds; the Mac consumes it immediately before it opens `tel:`, and there is no way
to reuse one. A call is logged whatever happened, including when no ticket existed,
and the outcome decides what follows.

## Where everything is

```
packages/domain/db/migrations/0006_policy.sql  the tables, the exclusion constraint,
                                               the supersession trigger, the view
packages/domain/policy/clock.ts                databaseNow
packages/domain/policy/holds.ts                list, open, release active_holds
packages/domain/policy/postures.ts             record, revoke, select the applicable one
packages/domain/policy/callingWindows.ts       the configured narrowing of the floor
packages/domain/policy/pauses.ts               administrative pauses and their holds
packages/domain/dial/authorize.ts              the eight steps
packages/domain/dial/identities.ts             register, attest, retire a calling number
packages/domain/dial/tickets.ts                mint, consume, read
packages/domain/dial/outcomes.ts               the 9.1 table, as a pure rule
packages/domain/dial/calls.ts                  log a call and apply its effects
packages/domain/dial/callbacks.ts              create on confirmation, complete
packages/contracts/src/dial.ts                 the wire contract the Mac shares
apps/api/src/routes/{postures,dial,calls,callbacks,pauses}.ts
apps/api/src/routes/callingIdentities.ts       /calling-identities and its three commands
apps/api/src/routes/dialSupport.ts             what the six route modules share
apps/desktop/src/main/dialHandoff.ts           the tel: handoff and its setup proof
apps/desktop/src/renderer/outcomeForm.ts       the outcome form, as a pure model
```

## The eight steps, and why the order is not the one you would choose

```
1. Effective firm, number, or relevant contact-handle suppression
2. Active verified calling identity owned by the actor
3. Active unretired usable route at the displayed version
4. Actor assignment and permission
5. Known firm state and confidently established actual IANA zone
6. Exactly one applicable state posture, review date not passed
7. Configured weekday and local calling window in the firm's actual zone
8. No applicable calling or restore pause
```

The numbers are in the code, in comments, so the order cannot drift without them
drifting with it.

Suppression before assignment is the surprising one. It means an unassigned
salesperson is told the firm is suppressed rather than that it is not theirs — and
that is right: the suppression is the more important fact and the one that must never
be worked around, including by asking a colleague to place the call.

Step 1 covers three keys in one statement: the firm, the number about to be dialed,
and every other phone handle of the same contact. The third is easy to miss. A
prospect who asked to stop on their mobile has not given permission for their desk
line, and both are the same person.

Step 3 compares the *displayed* version before it looks at eligibility. A card showing
version 1 of a route now at version 2 gets `route_version_stale`, not the new route's
state, because the honest answer is "your card is out of date".

Step 4 is not waived for admins. Section 9.1 requires an identity "owned by the acting
salesperson", and step 2 has already tied the call to this actor's own number; an
admin dialing someone else's firm from their own line is a call Callie made without
the assignee knowing.

Step 8 asks `active_holds` for everything blocking `dial_authorization` rather than
looking for pauses specifically, so the reassignment hold, the restore hold and
whatever a later lane adds all answer with their own reason code.

### The refusal codes

Section 15's vocabulary where it has a word, and a second closed set where it does
not. See `docs/decisions/g4-dial-refusal-codes.md`; the short version is that "that
identity is not yours" is not a hold, has no recovery action, and must not become a
row in a table whose intervals shift a schedule.

## Calling identities: the number a call leaves on

Step 2 needs an "active verified calling identity owned by the actor", and until lane
g60 nothing could make one. Now a salesperson registers their own number and attests
it (`docs/decisions/g60-calling-identities-are-attested-in-version-one.md`):

```
POST /calling-identities/register   { e164, label?, ownerUserId? }   unverified, disabled
POST /calling-identities/attest     { identityId, attested: true }   verified, enabled
POST /calling-identities/disable    { identityId }                   retired, row kept
GET  /calling-identities                                             the caller's own
```

* **Attestation is the verification in version one.** There is no telephony provider:
  a call is a `tel:` handoff and nothing FSS runs sees the line. So the person states
  that this is the number they place their calls from, and the row records who, how
  (`owner_attestation`, or `admin_attestation` for an admin on a member's behalf) and
  when. Migration 0016's `calling_identities_verification_recorded` refuses a verified
  row without those, so an `INSERT` is not a second way in.
* **The number is E.164 and no country is assumed.** `+`, a country code and the rest,
  8 to 15 digits; spaces, dots, hyphens and parentheses are dropped. Anything else is
  `number_invalid`.
* **Your own number is yours; anybody else's is an admin's.** Registering, attesting or
  retiring another member's number needs an admin, and the owner must be an active
  member. A colleague's identity is `identity_unknown`, not "not yours".
* **Registration is idempotent on the workspace and the number** and never changes an
  existing row, so a retry cannot undo an attestation. A number another member holds is
  `number_registered_to_another`.
* **Null-owner rows stay disabled.** The shared line is deferred (9.1). A hand-written
  one is refused attestation with `identity_shared_line_disabled`, the word step 2
  already uses.
* **Retirement keeps the row.** `call_logs` and `dial_tickets` reference it. Step 2
  refuses a retired number `identity_disabled`. Attesting it again brings it back.
* **The number Today dials from** is the most recently attested of the actor's
  verified, enabled numbers (`currentCallingIdentityId`). The Today card and the
  settings page ask the same function.

The refusals are `CALLING_IDENTITY_REFUSAL_CODES` in `packages/contracts/src/dial.ts`:
request refusals in the sense of `g4-dial-refusal-codes.md`, never holds, always a 409.
On the Mac, the control is the Settings screen's **Your calling number** section
(`docs/greenfield/settings.md`).

## Tickets

`dial_tickets` records what section 9.2 lists: database time, the route and posture
versions, the actor, the device, the assignment and the identity. `issued_at` and
`expires_at` are computed in SQL, so a client cannot mint itself a longer one, and a
CHECK refuses a row whose life exceeds sixty seconds.

Consumption takes the dial decision again (lane g79, audit S10). It locks the ticket,
re-runs `authorizeDial` at database time against exactly what the ticket recorded — the
firm, the contact, the route *at the recorded version*, the calling identity — and only
on an allow marks it consumed and issues the `tel:` URI. A suppression, a retired or
replaced route, a disabled identity, a revoked posture, a pause or a restore hold that
arrived inside the ticket's sixty seconds is refused with its own code, and the refusal
writes nothing: the ticket stays unconsumed and every further attempt is decided again.
Two Macs racing the same ticket serialize on the row lock, and the second reads it
consumed.

Replay is refused in three places, and all three have to agree:

1. `command_receipts_dial_result_not_actionable` refuses a receipt of kind
   `authorize_dial` that carries a result at all, so a replayed receipt is empty.
2. The route turns that empty replay into `already_consumed` rather than into an
   accepted command with a null body.
3. `dial_tickets_one_per_command` refuses a second ticket for the same command even if
   neither of the first two was reached.

That constraint is also why `/dial/authorize` does not use the shared command helper:
the helper records a refused command's reason in its receipt, and this kind may not
carry one. The decision travels back through the command's return value instead.

## Postures

`state_postures` is versioned per state with an exclusion constraint over effective
ranges, so two applicable rows cannot be written. Zero rows is `posture_missing` and
is refused by the reader, because a table cannot require a row it does not know is
wanted. Both halves of Appendix G 25 are tested.

Invariant 7 shapes the columns. The reference texts are **not** in the database: they
are in `packages/domain/src/rules/statePosture.ts`, verbatim, versioned by
`POSTURE_RULES_REVISION`, and a row records which revision the founder confirmed and
which statements they ticked. Storing the quotations in a table would have made the
reference material editable by an application role, which is the one thing invariant 7
is against. A partial confirmation is refused: a posture with three of the four
statements is a draft, and a draft that `authorizeDial` read as an allow would be the
worst possible outcome.

## The calling window

The floor is in code: `CALLING_WINDOW_FLOOR`, Monday to Friday 08:00 to 20:00 on the
firm's own clock, ported from the old build. `calling_windows` holds the configured
narrowing and its history, one current row per workspace as a partial unique index.

Hours clamp through the ported `narrowCallingWindow`; weekdays intersect. A
configuration outside the floor is *refused* rather than silently clamped, so an admin
who typed 07:00 is told the floor is 08:00 instead of discovering later that their
configuration did nothing. The clamp stays as the reader's safety net for rows written
before that check existed.

## Call outcomes

`callOutcomeEffects` is the 9.1 table as a pure function, one row per outcome, with
"no answer or busy" split into the two words a person would press. `logCallOutcome`
applies what it returns and decides nothing itself.

| Outcome | Manual | Other effect | Step |
|---|:---:|---|---|
| `interested` | yes | — | complete and advance |
| `referral_or_wrong_person` | yes | — | complete and advance |
| `callback_requested` | yes | callback, after a confirmed instant | complete and advance |
| `not_interested` | yes | suggests Lost; never closes | complete and advance |
| `do_not_call` | yes | suppresses the number; the firm only on request | complete and advance |
| `wrong_number` | no | retires the route | none |
| `voicemail_left` | no | — | complete and advance |
| `no_answer`, `busy` | no | — | the step's `advance \| retry_call` |
| `policy_or_technical_failure` | no | — | none |

"Call logging always records what occurred, even if no valid ticket exists; it never
refuses history." That sentence is about the *ticket*. Who may write onto whose firm is
a different question and is the CRM's usual one: `decideFirmMutation` under the firm's
row lock.

Since lane g79 the effect is applied, not only recorded. A call logged against its Today
task (`itemId`) is bound to the step execution behind it, `step_execution_id` is filled,
and the step's configured successor or `retry_call` is applied in the same transaction
from the frozen step — never from the request, whose `retryBehaviour` is ignored. An
engaged outcome completes the step with no successor and stops every live enrollment at
the firm at once (Appendix G 26). The command decides every refusal before it writes,
records the call, then applies the effects in a savepoint, so a refusal never leaves a
partial write and a call that happened is never refused: a callback without a confirmed
instant, a wrong number with no route, or an effect that could not be applied comes back
as a `followUps` entry beside the recorded call. The route must be the firm's and the
contact's, the ticket the firm's, the actor's and the route's, and "just now" is database
time. See `docs/decisions/g79-calls-carry-their-authorization.md`.

## Callbacks

Created only by the call outcome that asked for one, with the instant the salesperson
confirmed, inside that command's transaction — or, since lane g79, by
`POST /callbacks/schedule` for a recorded "call me back" that had no time yet, beside that
call. There is still no free-standing create endpoint: a callback with no record of the
call it came from is a callback nobody can explain.

The instant is the server's: `createCallback` resolves the local date, time and zone
through `callbackInstant` in `@fss/contracts` (the Mac calls the same function) and
refuses a supplied `dueAt` that disagrees, so a DST gap resolves forward to the first
valid time on both sides (`docs/decisions/g0-dst-gap-resolution.md`). Completing one
applies the CRM's assignment rule.

Appendix D wants four things stored and there are four columns — requested local date,
local time, source zone, resolved UTC instant. The UTC instant is what Today sorts on;
the other three are what lets the card say "Tuesday at 2pm" a month later, across a
zone change or a DST boundary, without recomputing a different answer.

## Pauses

Two rows committed together: the `active_holds` row that blocks the work and the
`administrative_pauses` row that is the history. Releasing clears exactly the hold
this pause opened — "clearing one hold never clears another" — and leaves the pause
row with its release recorded.

A channel pause's scope key *is* its channel. An `email` pause blocks `email_send` and
nothing else, which is 10.1's "a sending pause does not stop ... manual calling unless
calling is separately paused"; only a `call` pause or a pause over all automation
reaches `dial_authorization`.

A pause never writes a `suppression_events` row and never stops an enrollment
terminally, and the one way to keep that true is for `pauses.ts` not to know how to do
either.

## The Mac

`dialHandoff.ts` is ported from `src/main/communications/phoneHandoffLauncher.ts`.
Three things the old launcher got right are kept, each with the reason in a comment:

* the **exact-match** number check, because JavaScript's `$` also matches before a
  trailing newline, so `+14015550123\n` passes `test()` and would have been
  interpolated into a URI;
* the **inspection counter**, so a slow preflight resolving after a dial cannot re-arm
  a consumed attempt;
* **a failed open is `unknown`**, because by then bytes may already have reached the
  window server.

What is dropped is every decision. The old launcher consulted its own exclusion list;
this one checks that it holds a live server-issued ticket and dials the number the
server put on it. The setup proof is taken *before* the ticket is minted, so a Mac
with no phone app never spends one of the ticket's sixty seconds finding out.

`HANDOFF_LIMITATION_NOTICE` is 9.2's last clause as a constant, because "the product
states this limitation" is part of the contract and should be versioned with it.

## Running the tests

```
npm run gate:greenfield
npm run test --workspace packages/domain -- test/policy/appendixG.test.ts   # G 17, 21, 29, 30
npm run test --workspace packages/domain -- test/policy/policy.test.ts      # G 6, 25, 26
npm run test --workspace apps/api -- test/dial.test.ts                      # the routes and the journal
npm run test --workspace packages/domain -- test/policy/callingIdentities.test.ts  # register, attest, retire
npm run test --workspace apps/api -- test/callingIdentities.test.ts         # no Call button to an authorized dial
npm run test --workspace apps/worker -- test/suppressionFinalize.test.ts    # G 2 for this handler
npm run test --workspace apps/desktop -- test/dial.test.ts                  # the handoff and the form
```
