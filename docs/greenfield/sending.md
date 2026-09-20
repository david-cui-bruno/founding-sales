# Sending: what G7-1 established, and what G7-2 must add

Specification revision 3, sections 12.2, 12.5, 12.7, and Appendices B and G 19. G7-1
built the read half of the mail lane. Nothing in this repository sends mail yet. This
file is the contract the sending half inherits, written by the lane that fixed it, so
that G7-2 extends a design rather than negotiating with one.

## What is already fixed

**The scope is already granted.** `GMAIL_SCOPES` is `gmail.readonly` and `gmail.send`,
and the consent flow asks for both together. A mailbox connected by G7-1 can already
send; no re-consent is needed when sending arrives. `gmail.metadata` was considered and
rejected for the reason recorded in `mail/types.ts`: it cannot read a body, and the
deterministic classifier needs one to see an opt-out sentence.

**The footer is a database constraint, not a template convention.** `template_versions`
refuses any body or subject containing "unsubscribe", in any case, and refuses an
approved version that does not contain `Reply "stop"`. That is David's decision made
unrepresentable rather than documented. An approved version is immutable by trigger;
G8 extends the table with nullable columns.

**A direct send already switches the firm to manual.** Appendix G 19. When a sync
imports a message carrying the `SENT` label that FSS did not send,
`applyDirectSendEffects` switches an automated firm to manual **inside the importing
transaction**, and `mail_message_effects`'s uniqueness on
`(workspace, message, effect_kind, target_key)` makes it happen exactly once no matter
how many times the message is re-imported.

**The matching rules already have a slot for the fence.** 12.3's second matching rule
is "a Message-ID this system recorded". G7-1 satisfies it from
`mail_messages.rfc_message_id`, which covers replies to mail imported from the Sent
folder. G7-2 adds the outbound fence as a second source for the same rule — the one
that closes the gap between *sending* and *the Sent folder appearing in history*.

**Recovery already asks for the floor it cannot compute.** `RecoveryFloorSource` is a
port with `NO_RECOVERY_FLOOR` as its current implementation. 12.3 wants a recovery to
start from "the earlier of watermark minus one hour and the oldest unresolved outbound
message or active enrollment". The second clause needs `outbound_messages`, which is
G7-2's table. Implementing the port is the whole of the change.

**The disconnection metric is waiting on the same table.** 13.3 alarms on a mailbox
that "has sent in the last 30 days and remains disconnected for 48 hours".
`mailboxDisconnectedHours` is the query with the recent-sender clause left as a
parameter, so G7-2 supplies `recentSenderIds` and `MailboxDisconnectedHours` starts
being published in the same commit. Until then it is documented in
`apps/worker/src/bootstrap/metricCoverage.ts` as owed, because publishing the
disconnection half alone would alarm on a mailbox nobody has ever used.

## What G7-2 adds

* `packages/domain/outbound` — the at-most-once fence, the send path, the reputation
  ramp and the domain guard.
* `GmailClient.sendMessage` and `GmailClient.searchSentByMessageId` — Appendix B's
  `rfc822msgid:` Sent-folder search, which is how a send that timed out is confirmed
  rather than retried. `gmailClientHttp.ts` gains two methods; `gmailClientFake.ts`
  gains two recordings. Nothing about the read surface changes.
* The outbound fence as a second source for the Message-ID matching rule.
* `RecoveryFloorSource`'s real implementation.
* `recentSenderIds` for `collectMailMetrics`.

## The one rule worth restating

A refusal is a value, not an exception. Every expected Gmail outcome in this lane —
an expired cursor, a revoked grant, a rate limit, a message that vanished — is a
`{ ok: false, reason }` with a defined recovery, and only something nobody planned for
throws. Sending has more of these than reading does, not fewer, and the fence exists
because the worst of them ("did that send or not?") must never be answered by guessing.
