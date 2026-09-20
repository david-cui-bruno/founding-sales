# G7b: a quotation that is not in the message voids the whole answer

**Date:** 20 September 2026 · **Lane:** G7b reply classifier · **Spec:** 8.3, 12.4

## The silence

8.3 says a reply card contains a "supporting excerpt". 12.4 says the model layer
suggests and never decides. Neither says what to do when the excerpt is not in the
message.

This is not a hypothetical. A model asked for a supporting quotation will sometimes
produce a *paraphrase* that reads like a quotation — "they said Tuesday works for
them" when the message said "tues is fine" — and occasionally a sentence that is
simply not there. The card shows that string to a person, next to a disposition, as
the reason to believe it.

## Decision

The excerpt is verified against the message text, and a suggestion whose excerpt does
not verify is **discarded entirely**. Not the excerpt: the answer. The call is
recorded with `outcome = 'excerpt_unverified'`, no model classification row is
written, and the message stays uncertain with the deterministic layer's card.

Verification is `excerptIsVerbatim(excerpt, input)` in `classification/schema.ts`: a
substring match after flattening runs of whitespace, and **without** folding case. A
quotation that changed a word is not a quotation. A quotation that changed only the
line wrapping is, because the wrapping is ours — we flattened the body before sending
it.

## Why the whole answer and not just the excerpt

The tempting middle path is to keep the disposition and null the excerpt. It is the
wrong one, for a reason that has nothing to do with quotations.

The excerpt is the only part of the answer that can be checked. The disposition and
the confidence are opinions and there is nothing to compare them against; the excerpt
is a factual claim about a string we sent, and it is either true or it is not. A model
that made up the one checkable thing has told us something about the rest of the
answer, and the rest of the answer is what a person is about to act on. Keeping it
while discarding the evidence for it is keeping exactly the half we cannot audit.

The second reason is what the card would look like. A disposition with no excerpt
renders as "Callie suggests: Interested" with nothing under it, which is *less*
suspicious to a person in a hurry than a suggestion with a quotation they might have
read carefully. Silently degrading to the more trusting display is the wrong direction.

The cost is small and bounded: the message stays uncertain, the hold stays on, the
person reads the mail themselves. That is the state the system is designed to be safe
in, because it is the state every message is in before the model is asked.

## Not a retry

`excerpt_unverified` does not throw, so the job does not retry. The same prompt and
the same message will mostly produce the same answer, and a retry loop would be paying
twice for the same fabrication. Only `provider_error` throws.

## The tests

The corpus carries a `fabricated-excerpt` case whose recorded answer quotes a
sentence that is not in the body, and `authority.test.ts` runs it beside the other
four failure modes with the same assertions for all five: the outcome is recorded,
**no `layer = 'model'` row exists afterwards**, the message is left exactly as it was,
and the attempt is in `mail_classification_calls` so a dashboard can see the failure
rate.

`adapter.test.ts` holds the unit cases. One drives a fake SDK client whose answer
differs from the recorded one only in `supporting_excerpt`, and asserts
`excerpt_unverified`. Four more pin `excerptIsVerbatim` itself: the real sentence
verifies, one word changed does not, the same sentence in capitals does not, and
whitespace alone does not.
