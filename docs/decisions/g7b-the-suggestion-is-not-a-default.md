# G7b: the suggestion is shown, and nothing is preselected

**Date:** 20 September 2026 · **Lane:** G7b reply classifier · **Spec:** 8.3, 12.4

## The silence

8.3 puts the "proposed LLM disposition" and its confidence on the card. 12.4 requires
a person to confirm. Neither says whether the proposed disposition should arrive
**selected**.

The difference is one click, and it is the whole difference between "a person read the
model's answer and agreed" and "a person pressed the button that was already lit".

## Decision

`buildReplyCardView(state, card, chosen)` takes the person's choice as a parameter,
and the renderer's `chosen` starts as `null`. The suggestion is rendered as a
suggestion — its disposition, its confidence, its quotation, the model that produced
it — and the matching choice is marked `suggested: true`, which is a hint beside it
and not a selection. `confirmEnabled` is false until `chosen` is non-null, and the
button reads "Choose what this reply means" until then.

Nothing in the view model computes `chosen` from the card. There is no threshold
anywhere: a confidence of 0.99 and a confidence of 0.12 produce views that differ in
exactly one string.

## Why not preselect

A preselected radio would still be spec-conformant. 12.4 asks for a human
confirmation and a click on a preselected value is a human confirmation; the audit
would even record it correctly, as `corrected: false`.

It is refused for two reasons that are about the system's behaviour over a year rather
than about a single click.

**The audit becomes uninformative.** `mail_reply_confirmations.corrected` is the only
measurement of whether the model is any good. If the default is the model's answer,
`corrected: false` conflates "a person read this and agreed" with "a person clicked
through", and the two are indistinguishable afterwards. With nothing preselected, an
agreement is a positive act and the correction rate means what it says — which is what
tells an admin whether to move from Opus to Haiku, or to switch the classifier off.

**It is where the boundary would erode first.** 12.4's line is that the model suggests
and a person decides. A preselected answer is the smallest possible step across it,
and the step after — "skip the card when confidence is above 0.95" — is a
three-line change to a file that already contains a threshold. With no threshold in
the file at all, that change has to be written from scratch, past a test named for
what it is.

The cost is one click per reply, on a surface where the person is reading somebody's
mail anyway.

## What holds it

`apps/desktop/test/reply.test.ts`:

* "shows the suggestion and selects nothing": no choice is `selected`,
  `confirmEnabled` is false, and it becomes true only when a disposition is passed in.
* "never treats confidence as permission": the views for 0.99 and 0.12 are compared
  field by field with the suggestion removed, and asserted equal. A threshold anywhere
  in `buildReplyCardView` fails that assertion wherever somebody puts it.
