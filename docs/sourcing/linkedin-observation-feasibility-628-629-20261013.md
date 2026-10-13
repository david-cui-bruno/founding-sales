# LinkedIn observation feasibility and ticket refinements

October 13, 2026. Existing execution owners: #628 account/connection/manual observations, #629 selected business conversation capture/reply stop. David approved the bounded ticket-fit refinements at 17:48 UTC. No new product policy, dependencies or live authority are introduced.

## Outcome

Primary documentation and existing code provide useful leads, not proof of a fresh complete native observation path. Source implementation can define truthful positive/partial/unknown receipts and controlled fixtures now. Do not claim a usable live adapter from an interface that always returns unknown or from fabricated fixture identities/coverage. No archive/account read was performed.

## Primary evidence

Official LinkedIn Help, checked October 13, 2026: [Download your data](https://www.linkedin.com/help/sales-navigator/answer/a1339364).

- Invitations describes sent/received invitations, participant names/URL, date and message.
- Connections describes first-degree connections, public profile URL and connection date.
- Messages describes sent/received/archived messages, date, subject, content and member public profile URL.
- The article describes owner-requested exports and account-dependent category availability. Export delivery timing is not an activity watermark or freshness guarantee.
- The reviewed article does not specify immutable conversation/message IDs, exact timestamp/timezone semantics, complete current rolling-window coverage, deletion/tombstones or continuous selected-thread acquisition. This is a limit of the reviewed evidence, not a claim that no supported surface exists anywhere.
- Message exports include private content. Documentation availability is not permission to ingest unrelated personal/classmate bodies. A whole archive is not the selected-business source contract.

Existing native own-account identity/revalidation and posting receipt seams are reusable adjacent capabilities. Their presence is not accepted-connection, manual activity or reply-capture implementation. Existing email/phone reservations and cadence are not the new four-touch coordinated LinkedIn lifecycle.

## Narrow proposed receipt boundary

Keep observation facts separate from covered scope:

- Owner/account/scope revision and before/after identity binding.
- Observation method and time, source artifact/revision where available.
- Explicit stable source/profile/action identities and event times with provenance, not display-name guesses or invented IDs.
- Covered interval and business-thread/action scope, as-of watermark, gaps and complete/partial/unknown status.
- Manual/import/correction/native provenance and conservative dedupe against automated receipts.
- For permitted selected message content, original participant/time/context and source/access revisions; body-free versioned deletion barrier separately.

Do not invent a numeric freshness SLA. Consumers must evaluate whether the evidenced interval/scope actually supports the action at the relevant time. Observed events and unknown reservations are conserved; missing timestamps/coverage cannot turn counts into zero. An observed reply stops pending cross-channel work and creates a durable David handoff. Deletion does not clear confirmed stop facts or silently authorize recapture. A reply is not qualification.

## Prototype question and limits

A throwaway single-file in-memory logic demo under the research branch asks: can conservative count/coverage/identity receipts allow a supported synthetic positive while preserving holds on partial evidence, duplicate manual receipts, stale account/time observations, reply races and deletion?

The demo is not an export parser, native adapter, database journey or acceptance test. Synthetic stable identities and complete coverage are explicit assumptions, not documented LinkedIn fields. No validated production interface or numeric freshness rule is inferred from it. A successful walkthrough proves only behavior of that toy state model.

Open `packages/domain/social/prototype/observation-628-629.html` directly, with no server or install. Both inline scripts were syntax-checked. Seven reducer walkthroughs were executed in memory: synthetic positive allowed only the toy observation gate; duplicate manual observation counted once and partial reply history held; reply plus deletion retained stop/handoff; uncertain cancellation remained held; account/time changes held; mixed email/LinkedIn history reached four Person touches while only two counted as DMs; 20 account-wide manual DMs held. No browser-render/click validation, production tests, native adapter validation or provider acceptance is claimed. No prototype logic is promoted into production.

## Ticket updates and remaining work

Exact addenda were published and read back on #615, #617, #620, #621, #624, #628, #629, #632, #633 and #552. Bodies, labels and open state were unchanged. Native dependencies were not mutated. Clarifications name existing governed fact/message interfaces, consolidate already-required positive journeys and assign operating-document priority synchronization to #552. Actual root documentation synchronization is still pending normal review, not claimed done by a comment.

#604 already has the correct missing-evidence stop: full original observations and exact binding were not recovered. Repeating sparse exports or inventing a parser fix is not further research. Its authorized evidence-recovery/inspection preparation remains separate, with no task launch or database read here.

Smallest actual feasibility step after the synthetic contract: separately scoped read-only observation of one named account/business-thread/action surface, including supported identity/time/coverage evidence and privacy/cleanup limits. No such actual read, archive request, browser action, send, paid call, release, Enable or setting change is authorized by this note. #633 retains actual native/usefulness/activation evidence.
