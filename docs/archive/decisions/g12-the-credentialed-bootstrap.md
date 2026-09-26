# The credentialed bootstrap: one switch, no defaults, and two things infrastructure does not carry

**Lane:** G12 · **Spec:** 4.1, 10.2, 12.1–12.3, 16.2 · **Files:** `apps/{api,worker}/src/bootstrap/deployment.ts`, both `main.ts`

## What was open

The coordinator's note of 20 September: `apps/worker/src/bootstrap/main.ts` called
`mailHandlers(undefined)` and `outboundSendHandoff()` with no deps, so no mail handler
was registered and dispatch refused `mailbox_disconnected`. `ApiOptions.suppressionJournal`
defaulted to `localNoopSuppressionJournal()`. `researchHandlers({ providers: {} })`
registered nothing. Each of those was the honest state of a build with no credentials,
and each was one deployment away from being an outage nobody could see.

## The decision: the absence is always a value somebody typed

`FSS_DEPENDENCIES` has three values and no fallback in production.

| Value | Meaning |
|---|---|
| `live` | Build every real adapter. Any missing part is a refusal to start. |
| `recorded` | The rehearsal selection: the recorded Gmail client, a local envelope key, a named push verifier. |
| `none` | No Gmail, no classifier, no research. The kinds wait unclaimed in the queue. |

`FSS_ENVIRONMENT=production` refuses `none`, refuses `recorded`, and refuses the
variable being unset at all. So a production process cannot reach a no-op branch by
omission — only by a value an operator wrote, which would be visible in a plan review.

Three further rules follow the same shape:

* **The journal.** A live API goes through `requireDurableJournal`, which throws when
  the resolved journal is the local no-op. A live *worker* refuses without
  `FSS_JOURNAL_BUCKET` too, because the mail pipeline records prospect opt-outs and
  10.2 requires the journal write before acknowledgement.
* **Research.** There is no live research adapter in this repository — the only
  implementations are the recorded fixtures (`docs/archive/decisions/g10-provider-fixtures-only.md`).
  A live worker must therefore set `FSS_RESEARCH_PROVIDERS=none` explicitly. Declaring
  the absence is not the same as discovering it.
* **The rehearsal fakes are named.** A rehearsal API without its own `pushVerifier`
  refuses rather than falling back to Google's key set, because a rehearsal that reached
  the internet for key material would not be a rehearsal.

`--selftest` prints `describeDeployment`, which is booleans and closed vocabularies.
The tests feed the reader a generated marker string and assert the line does not
contain it.

## The push-token verifier

`publicKeyPushTokenVerifier` takes one key and its own comment says "the production one
fetches Google's key set". `googleOidcPushTokenVerifier` is that one: it reads
`https://www.googleapis.com/oauth2/v3/certs`, caches for an hour, and **tries every
key** rather than selecting by `kid` — a token whose `kid` is absent, unknown or
attacker-chosen must not steer key selection. `decidePushToken` still makes all six
claim checks afterwards, so a valid Google signature is never by itself an accepted
notification (Appendix G 27).

It lives in `apps/api/src/bootstrap` rather than `packages/domain/mail` because this
lane may make additive changes in the bootstrap files and not behaviour changes in
other lanes' packages.

## Google sign-in is deliberately not wired

`ApiOptions.auth` stays absent. It is G2's configuration, this brief does not name it,
and an OIDC client half-built by a release lane is worse than one that is honestly
missing: the API then serves `/healthz`, `/readyz` and the client-version notice and
refuses everything else, which is the documented behaviour of a deployment without its
Google configuration. The `session-signing-key` secret is read here because the Gmail
grant's state signing needs it; the sign-in half is the next lane's.

## Two dependencies added

`@aws-sdk/client-kms` (to `packages/domain`) and `@aws-sdk/client-s3` (to `apps/api`).
`loadKmsTransport` has imported the first dynamically since G7 and it was declared
nowhere, so the image would have failed at the first envelope operation; the second is
what `apps/api/src/journal`'s comment means by "the process that has credentials".
Both are loaded lazily, so a process that never uses them never imports them.

## What infrastructure does not carry, and why that is not an infrastructure change

Two public identifiers the Gmail lane needs are absent from the task environment:

* the Pub/Sub topic `users.watch` names — `gmail_push_topic_id` is only a Terraform
  *output*, never put into `local.common_environment`;
* the Workspace domain a connectable mailbox must belong to — nowhere at all.

Carrying them would need `infra/modules/stack/main.tf` to add two entries, and the
production root does not expose `extra_environment`, so it would need a root change as
well. This lane may not edit either. So both travel in the JSON the operator pastes
into `fss-prod/google-gmail-oauth-client`, beside the client id and secret:

```json
{"client_id": "...", "client_secret": "...", "push_topic": "projects/<project>/topics/<prefix>-gmail-push", "hosted_domain": "usecallie.com"}
```

They are public identifiers inside a secret entry, which is not ideal — but it is one
place, it is under David's hand at exactly the moment he already runs
`put-secret-value`, and every field is refused by name when absent rather than
defaulted. `docs/greenfield/release.md` states the shape, and the preferred
infrastructure fix (two lines in the stack module's `environment` map) is reported to
the coordinator rather than made here.

**One gap this lane could not close.** `infra/modules/cluster`'s worker task role has
`s3:GetObject`/`ListBucket` on the journal and `kms:Decrypt` on the journal key, but no
`s3:PutObject` and no `kms:GenerateDataKey`. A live worker that records a prospect
opt-out during mail sync must journal it before acknowledging, and will be refused by
IAM. That is an unavoidable module change; it is reported, not made.
