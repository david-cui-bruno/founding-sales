# Classification: the model layer, the reply card, and the confirmation

Specification revision 3, sections 8.3 and 12.4, invariant 6, and Appendices A, C, F
and G 35. This is the second half of reading a reply: G7's deterministic rules decide
what they can prove, and this lane asks a language model about what is left — under a
set of constraints whose whole purpose is that the answer can never be the last word.

## The short version

A matched incoming message is classified twice.

The **deterministic layer** runs first, inside the sync transaction, and is final
where it speaks: a bounce is a bounce, an explicit unsubscribe is an opt-out, an
`Auto-Submitted` header is an automated message. Nothing here can overturn it.

Everything it called `uncertain` is swept up by a scheduler source, enqueued as one
`classify.reply` job per message, and sent to the model as a single structured
request. What comes back is a *suggestion*: a disposition, a confidence, and a
verbatim quotation from the message that supports it. It is written as a second
`mail_message_classifications` row whose `class` column is the literal string
`uncertain`, enforced by a database constraint, and whose proposed class survives only
as a signal (`model_class: 'interested@0.96'`).

A **person** then confirms or corrects it on a reply card. That confirmation is the
only thing in the system that sets the opportunity to manual, releases the hold this
message opened, records a suppression, or commits a callback. The model can do none of
those, and the tests that say so are the point of the lane.

## Where everything is

| What | Where |
|---|---|
| Migration | `packages/domain/db/migrations/0011_classification.sql` — three new tables, three new columns |
| Domain | `packages/domain/classification/**` |
| Model seam | `classification/anthropicClient.ts` (transport interface + lazy SDK import), `adapter.ts` (the port implementation), `recorded.ts` (the fake with a real prefix cache) |
| Secret seam | `classification/anthropicClient.ts` — `CLASSIFIER_SECRET_NAMES`, mirroring `mail/secretProvider.ts` |
| The prompt | `classification/prompt.ts` — frozen, versioned `g7b.replies.1` |
| The output schema | `classification/schema.ts` — `MODEL_SUGGESTION_JSON_SCHEMA` and the reader that distrusts it |
| Rules the model may not break | `classification/classify.ts`, `confirmations.ts` |
| The card | `classification/cards.ts` |
| Configuration | `classification/settings.ts` — workspace-level, admin-only to write |
| Routes | `apps/api/src/routes/replies.ts` — five exact paths |
| Handler and sweep | `apps/worker/src/handlers/classify.ts` |
| Desktop | `apps/desktop/src/renderer/replyContract.ts`, `replyView.ts`, `apps/desktop/src/main/replyBridge.ts` |
| Tests | `packages/domain/test/classification/**`, `test/corpus/replies/**`, `apps/api/test/replies.test.ts`, `apps/worker/test/classifyHandlers.test.ts`, `apps/desktop/test/reply.test.ts` |
| Re-record script | `packages/domain/scripts/recordReplyCorpus.mjs` — spends money, never in CI |

## The authority boundary

12.4: *"The model layer suggests; it never decides."* Five things it may not do, and
what stops each. `packages/domain/test/classification/authority.test.ts` is one test
per row, against a real PostgreSQL.

| The model may not | What stops it |
|---|---|
| Release a message as automated | `mail_message_classifications_model_cannot_decide`: a row with `layer = 'model'` and `class <> 'uncertain'` is rejected by the database. The suggested class is written as a *signal*. |
| Close an opportunity | `confirmReplyDisposition` returns `suggestsLost` and touches no stage. No code path from a classification reaches `pipeline_stages`. |
| Create a suppression from ambiguous language | `recordSuppression` is called from exactly one place — a confirmation whose `disposition` is `opt_out` — and 12.4's explicit-unsubscribe rule is in the *deterministic* layer, where the evidence is a header or a literal phrase. |
| Commit a callback instant | The model's reading of a time is written to `callback_proposal` as **local wall-clock text**, never an instant. `createCallback` is reached only when a person's confirmation supplied one. A confirmation that drops a proposal is refused with `callback_required` rather than having the proposal used for it. |
| Resume automation | Nothing in this lane writes `control_mode = 'automated'`, and the only hold release is `releaseHoldsOfEvent` inside the same transaction that sets `manual` — after which automation is ineligible for ever (7.3, 4.3). |

The desktop carries the same boundary as a shape rather than a check: `ReplyBridge`
has five methods and none of them is a close, a suppress or a release, and
`buildReplyCardView` will not enable Confirm until a person has chosen — a 0.99
confidence changes one label and nothing else (`apps/desktop/test/reply.test.ts`).

## The model call

Everything about the request is either a constant in `prompt.ts` or a row in
`classifier_settings`. Nothing is a literal at the call site.

* **Model and effort are configuration.** `classifier_settings.model_name` defaults to
  `claude-opus-5` and `effort` to `low`; `claude-haiku-4-5` is the cheaper alternative
  and an admin switches with `POST /replies/settings/update`. `MODEL_CAPABILITIES`
  knows that Haiku 4.5 rejects `output_config.effort` with a 400, so the field is
  *omitted* for it rather than sent and ignored.
* **Structured output, not tool use.** `output_config.format` carries
  `MODEL_SUGGESTION_JSON_SCHEMA`: seven required fields, `additionalProperties: false`.
* **Prompt caching is a prefix.** The system block carries
  `cache_control: {type: 'ephemeral'}` and is frozen; everything that varies is in the
  user turn *after* the breakpoint. `recordedAnthropicTransport` derives its cache
  state from the bytes of that prefix, so `prefixCount() === 1` across the whole corpus
  is a real assertion that nothing drifted into the cached region.
* **Server-side fallbacks** (`betas: ['server-side-fallback-2026-07-01']`,
  `fallbacks: 'default'`) are sent for Opus 5 only, because that is where they exist.
* **No `thinking`, no prefill, no sampling parameters.** A classification is a short
  structured answer and each of those would either cost money for nothing or make the
  cached prefix volatile.
* **Refusals are checked before content.** `stop_reason === 'refusal'` is read first,
  and the row is recorded with `outcome = 'refusal'` and a refusal category. A refusal
  is not an error: the message stays uncertain and a person still sees a card.

### The silent invalidators of the cache

Prompt caching matches a *prefix*, in the order tools → system → messages. Any of
these changes the prefix and quietly halves the economics without failing a test that
is not looking for it:

1. Editing `CLASSIFIER_SYSTEM_PROMPT` at all, including whitespace.
2. Changing the model — a cache entry belongs to one model.
3. Changing `effort`, or sending it to a model that rejects it.
4. Adding or reordering `betas`.
5. Moving anything volatile (the message, the date, the signals) above the breakpoint.
6. Adding a `tools` array, which would sit *before* the system block.

`corpus.test.ts` asserts `prefixCount() === 1` over all seventeen cases, so 1, 5 and 6
fail loudly. 2, 3 and 4 are configuration and are asserted in `adapter.test.ts`
against the exact request shape.

## What is recorded, and what is never recorded

`mail_classification_calls` is append-only (`REVOKE UPDATE, TRUNCATE`) and holds one
row per *attempt*, including the attempts that never left the process:

| `outcome` | Meaning | `request_sent` |
|---|---|---|
| `accepted` | A suggestion that parsed and whose quotation was verbatim | true |
| `refusal` | `stop_reason: 'refusal'` | true |
| `malformed` | Not JSON | true |
| `schema_invalid` | JSON that the frozen schema rejects | true |
| `excerpt_unverified` | A quotation that is not in the message — see the decision record | true |
| `provider_error` | The transport threw; the job retries once | true |
| `disabled` | The workspace switched it off, or the process has no key | **false** |
| `capped` | The workspace's daily call cap is spent | **false** |
| `not_applicable` | The deterministic layer already decided | **false** |

`mail_classification_calls_unsent_spent_nothing` and `_unsent_outcome` make the last
three rows structurally free: a row that spent tokens cannot claim to be one of them,
and one of those three cannot claim to have sent a request.

**The message is never in this table.** Not the body, not the subject, not the
excerpt, not the sender. It holds counts, a latency, a stop reason and a category.
Errors thrown by the adapter carry no request text either; that is asserted in
`adapter.test.ts`, because an error string is the easiest place in a system for a
message body to end up in a log.

The API key is never in a file, a fixture, a test literal or a log. It comes from the
injected secret provider (`FSS_LLM_CLASSIFIER_API_KEY` in the environment, a KMS-backed
provider in production), and a worker started without it registers no classify handler
at all — which is `describeClassifier()` printing `classifier: false` in the startup
line and nothing else.

## The corpus

`packages/domain/test/corpus/replies/` holds seventeen synthetic cases and their
recorded answers. Every person, firm and address in it is invented; `example.test` is
reserved by RFC 6761 and the telephone numbers are in the NANP 555-01XX fictional
block. There is no real correspondence anywhere in this repository.

Five are cases the model is never asked about, because a rule already decided: a
delivery-status notification, a vacation notice, a ticket acknowledgement, a
newsletter, and an explicit unsubscribe. They are in the corpus precisely to assert
the `not_applicable` outcome — a corpus of only the interesting cases would not
notice the day the model started being asked about bounces.

The other twelve are model cases. Five are failure fixtures — malformed output, output
the frozen schema rejects, a refusal, a fabricated quotation, a transport error — and
the rest are the shapes 12.4 names: a terse human reply, a sender on an alias, a
referral, a callback proposed in words, a message a rule would have called automated,
an ambiguously worded opt-out that must **not** become a suppression, and a message
carrying an instruction addressed to the model, which the prompt is built to read as
content rather than as direction.

### Re-recording

Tests never call Anthropic. `recorded.json` is refreshed by hand, deliberately, with

```
FSS_LLM_CLASSIFIER_API_KEY=… \
  node --experimental-transform-types --disable-warning=ExperimentalWarning \
    packages/domain/scripts/recordReplyCorpus.mjs --model claude-opus-5
```

The script refuses to run without both the key and an explicit `--model`: a default
model here would mean silently re-recording against whichever one somebody last edited
a constant to. `--dry-run` prints the request the first case would send and spends
nothing, which is the right way to look at a prompt change before paying for the other
seven. The five failure fixtures are never re-recorded: asking a model to produce
malformed output on demand is not a recording, and re-recording `fabricated-excerpt`
against a model that quotes correctly would quietly turn the fixture into its own
opposite.

**When to re-record.** Whenever `CLASSIFIER_PROMPT_VERSION` changes, and at no other
time. Bumping the version without re-recording makes `corpus.test.ts` fail on the
pinned version, which is the intended nag.

## The job and the sweep

Appendix A says the LLM classification *may be queued* after the sync transaction
commits, and that is what happens. The sync does not enqueue it — G7's pipeline is
another lane's file, and a scheduler sweep is the shape Appendix A's "may" describes
anyway. `classifyReplySource()` lists messages whose deterministic row says `uncertain`
and which have no model row yet, and enqueues `classify.reply` with idempotency key
`classify-reply:<messageId>` under `business_uniqueness` protection. A partial index,
`mail_message_classifications_uncertain_deterministic`, is what makes that sweep cheap.

The handler throws only on `provider_error`, so a refusal, a malformed answer or a
fabricated quotation is a recorded attempt and not a retry loop. `maxAttempts` is 2 and
the lease is 120 seconds; the stolen-lease probe asserts that two workers running the
same job produce one model row.

## Two workspaces, one model

`classifier_settings` is keyed by workspace, the daily cap is counted per workspace
against the workspace's own business date, and every read in this lane goes through
`RepositoryContext`. Appendix F's read matrix applies to the card: a member who is
neither the assigned salesperson nor an admin sees the envelope, the class, the
signals and the firm-wide impact — and no body, no subject, no contact name and **no
excerpt**, because the excerpt is a quotation from the body and a card that redacted
one while printing the other would be the same leak with more steps.

## What is deliberately not here

* **Resolving an ambiguity.** G7 mounts `/messages/resolve-ambiguity` and the card's
  `nextAction` names it. See `docs/decisions/g7b-ambiguity-stays-where-g7-put-it.md`.
* **Closing an opportunity.** 9.1 gives that to a person on the firm page.
* **Any use of the model outside reply classification.** No summarisation, no drafting,
  no enrichment. The transport interface has one method and the prompt has one job.
* **The reply window's HTML.** The card shell is G6's Today window; this lane supplies
  the contract, the view model and the bridge. See
  `docs/decisions/g7b-the-desktop-window-is-not-wired-up.md`.

## Running the tests

```
npm run gate:greenfield              # everything
npm -w @fss/domain run test -- test/classification    # 51 tests, real PostgreSQL
npm -w @fss/api run test -- test/replies.test.ts      # the five routes
npm -w @fss/worker run test -- test/classifyHandlers.test.ts
npm -w @fss/desktop run test -- test/reply.test.ts    # the view model and the bridge
```

None of them reaches the network. The adapter test drives a fake SDK client and
asserts the exact request that would have been sent; the corpus test drives the
recorded transport and asserts the answers we actually got, once, on a day somebody
paid for them.
