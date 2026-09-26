# G7b: which layer's disposition the card proposes

**Date:** 20 September 2026 · **Lane:** G7b reply classifier · **Spec:** 8.3, 12.4

## The silence

A message can have two classification rows: the deterministic one and the model's.
Both may carry a `suggested_disposition`. 8.3 says the card shows "the proposed LLM
disposition"; it does not say what happens when a rule proposed one too, and 12.4's
"the deterministic layer is final where it speaks" is about the *class*, not about the
disposition.

## Decision

`proposedDispositionOf(deterministic, model)` in `classification/store.ts`:

> The deterministic layer's disposition wins **only when it also proved a class** —
> that is, when its class is something other than `uncertain`. Otherwise the model's
> wins. Otherwise there is none.

The card reports which with `proposedBy: 'deterministic' | 'model' | 'none'`, and the
confirmation records it in `suggested_by`, so 12.4's "a corrected classification is
audited" can tell a person correcting a rule from a person correcting a model.

## Why the class is the qualifier

The first version was simply "the deterministic layer wins if it has a disposition",
and it was wrong on a case in the corpus.

The rules propose `interested` for a message that asks a question, because a prospect
asking a question is usually interest. They apply that heuristic without proving a
class, so the row reads `class: 'uncertain', suggested_disposition: 'interested'` —
which is honest: the rule is guessing, and it says so by leaving the class uncertain.

"Could you take me off this thread?" ends in a question mark. Under the first rule the
card proposed **Interested** for a message asking to be left alone, with the model's
`opt_out` suggestion sitting unused in the row underneath. A person in a hurry clicks
the proposal.

Tying the disposition to the class fixes it in the right direction rather than by
special-casing the phrase. A deterministic row that proved nothing has no standing to
outrank a model that read the sentence; a deterministic row that proved something —
`bounce`, `automated`, an explicit `opt_out` — has every standing, and the model is
not even asked in those cases.

## What it does not do

It does not let the model override a proven class. The class on the card is always the
deterministic one; the model's opinion about the class is a signal
(`model_class: 'opt_out@0.94'`) and never the answer, which is a database constraint
rather than a convention.

## The tests

* `cards.test.ts`: the take-me-off-this-thread case proposes `opt_out` with
  `proposedBy: 'model'`, and a rule that proved a class proposes its own with
  `proposedBy: 'deterministic'`.
* `confirmation.test.ts`: `suggested_by` on the stored confirmation matches the card's
  `proposedBy`, and `corrected` is true exactly when the person's disposition differs
  from the one that was proposed.
