# G7b: what a suggestion says it came from

**Date:** 20 September 2026 · **Lane:** G7b reply classifier · **Spec:** 12.4, 13.2

## The silence

12.4 requires the model layer to be versioned: a suggestion is only interpretable if
you know what produced it. It does not say what "what produced it" is made of, and
there are three plausible answers to each half — the model, and the prompt.

## Decision

`mail_message_classifications` records, for a model row:

| Column | Where it comes from |
|---|---|
| `model_name` | the **response's** `model` field, not the request's |
| `prompt_version` | the `CLASSIFIER_PROMPT_VERSION` constant, not anything in the answer |
| `effort` | the settings row the request was built from |

And the two identifier rules:

* **The allow-list is a list of models the adapter has been told about**, not a shape
  rule about the string. `CLASSIFIER_MODELS` is `['claude-opus-5', 'claude-haiku-4-5',
  'claude-haiku-4-5-20251001']`.
* **The model's own claim about itself is never used.** The answer schema *does*
  require `model_version` and `prompt_version` — a required field the model must fill
  in is a cheap consistency signal, and the schema is `additionalProperties: false`
  so an answer either has them or is rejected outright. The adapter then overwrites
  both, from the response and from the constant. They are read only as evidence that
  the answer came from a model that was given this prompt.

## Why the response's model rather than the request's

Server-side fallbacks are enabled for Opus 5 (`fallbacks: 'default'`). The point of a
fallback is that the request named one model and a different one answered. A row that
recorded the request's model would be quietly wrong exactly when it mattered most —
during the incident that triggered the fallback — and the correction rate for "Opus"
would silently include a week of some other model's work.

`response.model` is what actually answered. It is also the only field that can be
trusted here, because it is the API's, not the model's.

## Why the prompt version is a constant and not a claim

A model asked to report the prompt version it was given will report one. It will
usually be right, which is worse than always being wrong, because it means nobody
notices the day it is not. The prompt version is a fact about our own source code and
we have it to hand; recording a third party's answer to it is a category error.

The field stays in the schema anyway, because the *shape* of the answer is worth
constraining even where the content is not trusted: an answer missing it fails the
schema read, which is one more way a model that has wandered off the format announces
itself before a person sees anything.

## Why both spellings of Haiku 4.5

Opus 5 has one id, `claude-opus-5`. Haiku 4.5 has two the API accepts — the undated
alias `claude-haiku-4-5` and the `-20251001` snapshot — and David's environment
documents the dated one. Both are in the allow-list.

The lane's first version allowed only the undated alias, on the general rule that
current model strings are unsuffixed and that appending a date is a habit from older
model families. That rule is right as advice and wrong as a constraint here: the thing
the allow-list protects against is a model the adapter has no capability row for — one
whose `output_config.effort` support nobody has checked — and a snapshot id the API
takes is not that. Refusing a string the provider would have accepted turns a
documentation difference into an admin's afternoon.

So the rule is stated as what it actually is: **every entry in `CLASSIFIER_MODELS` has
a row in `MODEL_CAPABILITIES`**, which `cards.test.ts` asserts, and the two Haiku
spellings have identical rows because they are one model.

### The CHECK that was removed

`0011_classification.sql` briefly had a second constraint on `model_name`,
`classifier_settings_model_has_no_date_suffix`, forbidding a trailing `-20YYMMDD`.

It was deleted twice over. First because it could never be the *sole* violation — every
string with a date suffix also failed the allow-list — so `constraints.test.ts`, which
requires a failing insert per enforced constraint, could only cover it with a case whose
outcome depended on the order PostgreSQL happened to evaluate the checks in; a
constraint whose test is order-dependent is a flake waiting for a version upgrade. And
second because the rule it encoded turned out to be wrong, as above.

The failing-insert fixture for the allow-list is now `claude-3-haiku-20240307` — a real
model, retired, and unrelated to anything this workspace calls.
