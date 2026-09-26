# G7b: resolving an ambiguity stays on G7's route

**Date:** 20 September 2026 · **Lane:** G7b reply classifier · **Spec:** 8.3, 12.3

## The silence

8.3 says the reply card carries a "suggested next action", and 12.3 says an ambiguous
message is resolved on to one conversation before anything acts on it. The card's next
action for an unresolved ambiguity is therefore "resolve this ambiguity" — and G7
already mounts `POST /messages/resolve-ambiguity` to do exactly that.

The spec does not say whether the reply surface should have its own resolution
command. A reply window that had to send the person to a different endpoint feels like
a seam showing.

## Decision

There is no `/replies/resolve-ambiguity`. The card's `nextAction` names
`resolve_ambiguity`, the card carries the candidate opportunities so the window can
render the choice, and the command the window sends is G7's.

`confirmReplyDisposition` refuses an unresolved ambiguity with
`ambiguity_unresolved` rather than resolving one implicitly.

## Why

12.3 allows **one** resolution per message. Two paths that both resolve it are two
places that have to agree about what resolution means — which candidate becomes
selected, which holds are released, what is audited — and the day they disagree the
symptom is a message resolved twice onto different conversations, which nothing later
can tell happened.

The seam is also not where it looks. The reply card is a *view* assembled from five
lanes' tables; it already shows G4's holds, G6's today item and G3a's firm without
owning any of them. Resolution is one more thing it shows and does not own.

And the refusal is not a dead end for the person: the card says which command to run,
the window has the candidates, and the whole round trip is one click that happens to
post to a different path. The alternative — a convenience wrapper on `/replies` that
forwards to the same domain function — would be a second URL for one command, which
is exactly the kind of thing the route registry's exact-path claims exist to make
visible.

## What holds it

* `apps/api/test/routeMounting.test.ts` pins the five `/replies*` paths exactly and
  asserts that `/replies/confirm-all` and `/replies/settings/reset` belong to nobody.
  A sixth reply path cannot appear without editing that list.
* `packages/domain/test/classification/authority.test.ts` asserts that a confirmation
  against a message with two unselected candidates is refused with
  `ambiguity_unresolved`, and that the candidates are untouched afterwards.
* `cards.test.ts` asserts `nextAction === 'resolve_ambiguity'` outranks everything
  else, including a confident model suggestion.
