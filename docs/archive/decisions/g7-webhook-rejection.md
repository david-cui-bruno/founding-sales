# G7: a refused Pub/Sub push is refused, not acknowledged

**Date:** 20 September 2026 · **Lane:** G7 gmail · **Spec:** 4.1, 12.3, Appendix G 10 and 27

## The question

`POST /integrations/gmail/push` can refuse a notification for seven reasons. Six are
about the OIDC push token — a bad signature, the wrong issuer, the wrong audience, the
wrong service account, an unverified address, an expired or future-dated token — and
one is about the mailbox: the address in the notification belongs to no mailbox this
deployment knows, or to one that is disconnected or revoked.

Pub/Sub reads the HTTP status as an acknowledgement. A 2xx means "delivered, forget
it"; anything else means "deliver again, and keep trying until the subscription's
retention expires". So the status code is a decision about what happens to mail that
arrives for a mailbox FSS cannot place.

## Decision

Every refusal is a non-2xx.

* A push token that fails any of the six claim checks is **401**.
* A notification for an unknown, disconnected or revoked mailbox is **404**.
* Only a notification that reached `coalesceMailSync` and committed is **200**.

All seven return the same redacted body — `{"error":"push_refused"}` and one sentence —
and the reason goes to the log as `gmail_push_<refusal>`, never to the caller.

A refusal for a *known but inactive* mailbox is additionally counted: the endpoint logs
the event even though it writes no row, because rows are only written once the mailbox
resolves. A mailbox whose grant was revoked but whose watch is still live keeps
producing push, and that is a state an operator should be able to see on a dashboard
rather than infer from silence.

## Why not acknowledge and drop

Acknowledging an unknown mailbox is the tidier-looking choice: the subscription's
backlog stays at zero and nothing retries. It is wrong for two reasons.

**A mailbox is unknown for recoverable reasons.** A deployment that has just been
restored, an API that came up before its database, a mailbox a salesperson is about to
reconnect after a password change — in each case the notification is about mail FSS
will want, and the subscription's retention is exactly the grace period that makes it
recoverable. Acknowledging spends that grace period on nothing.

**Silence is the failure mode this lane already fears.** 12.3's coverage watermark and
its recovery both exist because mail that was never imported leaves no trace. An
acknowledged-and-dropped push is the same hazard one layer up: the subscription's
backlog would be zero, the dead-letter count zero, and the mailbox quietly behind.

## What it costs

A permanently unknown mailbox — a stale subscription pointed at a deployment that no
longer has that mailbox — produces a retry backlog that grows until retention drops it.
That is visible, which is the point, and the remedy is the ordinary one: delete the
subscription or reconnect the mailbox. It is a nuisance, not an outage, and it is
strictly better than a nuisance nobody can see.

## The refusal codes are a security surface

This is the one route in the API with no session; the push token *is* the
authentication. So the seven refusals must not be distinguishable from outside. An
attacker probing the endpoint learns only "refused" and the status class, and the
status class is already implied by whether they hold a valid Google-signed token at
all. Everything finer — which claim failed, whether an address is a mailbox here — is
in the log, where the operator is.

## The mailbox lookup is unscoped, and ambiguity is refused

One more thing this endpoint does that no other route does: it reads `mailboxes`
**without a workspace scope**. It has to. A Pub/Sub notification carries an email
address and a history id, and nothing else — there is no workspace in it, and the
signed token proves only that Google sent it.

So the lookup is by address across every workspace, and there is a third outcome
besides found and not-found: the same address is a connected mailbox in **two**
workspaces. Appendix G 8 requires that to be possible, since every uniqueness in this
schema is scoped by workspace.

That case is refused with `mailbox_ambiguous`. Picking one — by creation order, by
which is more recently synced, by anything — would deliver one workspace's mail into
the other workspace's history, and no later repair would find it, because nothing
downstream records which mailbox a message *might* have belonged to. It is the worst
failure this system can have, and it is worth a loud refusal and an operator
disconnecting one of the two.

Once the mailbox resolves, everything after it is scoped normally: the dedupe row, the
coalesced job and the sync all run under that mailbox's workspace.
