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

* **Model ids carry no date suffix.** `CLASSIFIER_MODELS` is
  `['claude-opus-5', 'claude-haiku-4-5']`.
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

## Why no date suffixes

The Anthropic API skill is explicit that current model strings are unsuffixed
(`claude-opus-5`) and that appending a date is a stale habit from older model
families. The lane brief mentioned `claude-haiku-4-5-20251001`; the constant is
`claude-haiku-4-5`, and this is the deviation to flag rather than bury. If a future
deployment genuinely needs a pinned snapshot, it is one entry in `CLASSIFIER_MODELS`
and one row in `classifier_settings`, and the check constraint is the thing that would
need editing — deliberately.

### The CHECK that was removed

`0011_classification.sql` briefly had two constraints on `model_name`: an allow-list,
and `classifier_settings_model_has_no_date_suffix`, forbidding a trailing `-20YYMMDD`.

The second one was deleted. It could never be the *sole* violation — every string with
a date suffix also fails the allow-list — so `constraints.test.ts`, which requires a
failing insert per enforced constraint, could only cover it with a case whose outcome
depended on the order PostgreSQL happened to evaluate the two checks in. A constraint
whose test is order-dependent is a flake waiting for a version upgrade.

The rule now lives where it can be tested honestly: `CLASSIFIER_MODELS` in
`classification/types.ts`, with a TypeScript assertion that no entry matches
`/-20\d{6}$/u`. The allow-list constraint keeps the database's promise, and its
failing-insert case uses `claude-haiku-4-5-20251001` — so the exact string the brief
suggested is now the fixture for "a model this workspace will not call".
