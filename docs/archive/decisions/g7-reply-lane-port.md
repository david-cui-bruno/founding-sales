# G7: the reply lane is a port until G6's migration lands

**Date:** 20 September 2026 · **Lane:** G7 gmail · **Spec:** Appendix A "Record uncertain or ambiguous reply", 12.4

## The requirement

Appendix A's reply flow says the message, its match candidates, their holds and the
today-list item are one transaction. G6 owns the today list and exposes

```ts
promoteReply(context, { firmId, contactId?, messageId, receivedAt })
```

from `@fss/domain/today`, which writes a `today_items` row with `item_key`
`reply-message:<messageId>`, kind `reply`, source kind `reply_message`, lane 1.

G6's migration `0008_today.sql` is final but was not on `main` while this lane was
built, so `@fss/domain/today` does not resolve on this branch.

## Decision

`packages/domain/mail/replyLane.ts` declares a `ReplyPromoter` port with exactly G6's
signature, and every call site takes it as a dependency. There are two fakes:
`recordingReplyPromoter()` for tests that assert the call, and
`pendingReplyPromoter()`, which counts deferrals for a process that has the mail lane
but not the today lane.

`0008_today.sql` reached `main` while this lane was finishing, so the real adapter is
now wired: `todayReplyPromoter()` in `apps/worker/src/handlers/mail.ts` forwards to
`promoteReply` and does nothing else. `packages/domain/today` was already in both image
allow-lists by then, so nothing moved there.

`pendingReplyPromoter` stays. A process that has the mail lane and not the today lane
is no longer the repository's state, but it is still a state a deployment can be in
during a rolling step, and counting the deferrals is better than a crash — the
`reply_lane_entry` effect row is written either way, so the reply appears on the card
the next time Today is built.

## Why a port rather than waiting

Two lanes were in flight against each other. Waiting would have serialised them for a
day to avoid a five-line adapter, and the port is not a fiction: the mail lane genuinely
should not know how a today item is built, and the effects code is more honest for
saying "promote this reply" rather than "insert this row".

## What the port must preserve, and how the tests hold it

The port is worthless if it relaxes the transaction boundary, so the tests assert the
boundary rather than the call:

* `recordingReplyPromoter` records the `RepositoryContext` it was handed, and the
  scenario test asserts it is the *same* session the message and its holds were
  written on. A promoter that opened its own connection would fail that assertion.
* The production adapter is tested the other way round, in
  `apps/worker/test/mailHandlers.test.ts`: it promotes inside an open transaction and
  the test rolls back, then asserts the `today_items` row is gone. An adapter with its
  own connection would leave it behind.
* The arguments are asserted exactly: firm, message and `receivedAt`, with `contactId`
  present only when the match named a contact.
* `replyItemKey(id)` is in the mail lane and spells `reply-message:<id>`, so a
  disagreement with G6 about the key is a failing string comparison in one place
  rather than a duplicate today item in production.

Two further facts from G6's brief are recorded here because the mail lane has to not
break them, and nothing in the mail lane's own tests would catch it: an uncertain and
an ambiguous reply use the **same** kind, and the daily rebuild never cancels reply
items. The firm card recomputes itself by trigger, so this lane never writes
`today_snapshots` — and it does not import them at all, which is the strongest form of
never.
