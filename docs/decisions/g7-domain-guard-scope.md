# G7-2: the domain guard counts the domain and holds the firm

**Date:** 20 September 2026 · **Lane:** G7-2 sending · **Spec:** 12.6

## The sentence

"FSS enforces a rolling primary-domain guard at 4,000 personal-Gmail recipients per 24
hours while reply-only opt-out remains configured. Reaching the guard holds further
affected sends and requires a reviewed product-policy change; it cannot be bypassed
with extra mailboxes."

Four decisions come out of it, and three of them are easy to get subtly wrong.

## Where the number lives

On `sending_domains`, not on `mailboxes`. The count query groups by nothing and takes
no mailbox parameter at all: it counts every `sent` fence in the workspace whose
recipient is on personal Gmail, inside the window, plus every outgoing message the mail
sync imported that FSS did not send.

That placement *is* "cannot be bypassed with extra mailboxes". Connecting a second
mailbox adds a row to `mailboxes` and changes nothing here. A per-mailbox guard would
be doubled by the obvious workaround, and it would be doubled quietly.

## Rolling, not daily

The window is the last 24 hours from now. A guard that reset at midnight could be
satisfied by sending 4,000 at 23:00 and 4,000 at 01:00 — 8,000 in two hours, which is
exactly the traffic shape Google's rule is about.

## Messages, not distinct recipients

Two messages to the same personal Gmail address count twice. Google counts recipients,
so this over-counts on purpose: a guard that under-counted would be no guard, and the
cost of the conservative reading is that the hold arrives slightly early.

## Only personal Gmail

`gmail.com` and its historical alias `googlemail.com`. A Workspace mailbox on a
customer's own domain is not a personal Gmail account and is not covered by the rule.
Counting it would make the guard fire on traffic nobody objected to.

## The hold is on the firm, not the workspace — and that is the subtle one

The first implementation opened a *workspace-scoped* hold on reaching the guard, on
the reasoning that the guard is a domain-wide fact and a firm-scoped hold would let the
next firm's send through.

That was wrong, and the scenario test caught it: a workspace-scoped hold on
`email_send` blocks **every** send, including the ones to recipients who are not on
personal Gmail. 12.6 says the guard "holds further *affected* sends", and a message to
`reception@northwind.example.test` is not affected by Google's personal-Gmail rule. The
over-broad hold was a self-inflicted outage on traffic the rule does not cover.

So the hold is firm-scoped like every other fence hold, and the enforcement lives
where it always did: `decideDomainGuard` runs inside the gate, on **every** send,
against the domain-wide count. The hold's job is to stop the automation churning and to
make the state visible on the hold list; it is not the mechanism.

`domain_cap` is deliberately absent from `RECOVERABLE_HOLD_REASON_CODES`. 12.6 says
reaching the guard "requires a reviewed product-policy change", so no control may clear
it early — it lifts when the rolling window moves, which is a fact about time rather
than a decision anybody makes.

## Why there is no command to change the guard

`personal_gmail_guard_per_24h` is a column so that a change is an audited `UPDATE` of
one row rather than a release. There is deliberately no route for it. 12.6 calls the
change "reviewed", and putting a number field on an admin screen turns "reviewed
product-policy change" into "an admin in a hurry". An operator changes it with a script
and a record of the review.
