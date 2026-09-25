# Each task definition gets the secrets its own process reads

**Lane:** g81 · **Date:** 25 September 2026 · **Spec:** 5.1, 10.3 · **Evidence:** audit `GPT6-ASTRA-EXHAUSTIVE-20260925`, item S17

## The gap

The API, worker, operations and drill task definitions all got one map, `task_secrets`.
It held every application secret plus the runtime database entry. So the worker, the
operations tool and the drill each held three things none of them reads, all of it the
API's authentication material:
- the session-signing key,
- the device-credential pepper,
- the Google sign-in client.

## What each process reads (checked in code, 25 September)

| Process | Secrets it reads | Where |
|---|---|---|
| API | `google-gmail-oauth-client`, `google-oidc-client`, `session-signing-key`, `DATABASE_SECRET_ARN` | `apps/api/src/bootstrap/deployment.ts`, `config.ts` |
| worker | `google-gmail-oauth-client`, `DATABASE_SECRET_ARN`, and the classifier key as `FSS_LLM_CLASSIFIER_API_KEY` | `readGmailDeployment`, `bootstrap/config.ts`, `handlers/classify.ts` → `environmentClassifierSecrets` |
| operations (`fss`) | `google-gmail-oauth-client` (mail commands, via `readWorkerDeployment`), `DATABASE_SECRET_ARN` | `tools/fss.ts`, `tools/fss/config.ts` |
| drill (`fss drill`) | the operations set plus `MIGRATION_DATABASE_SECRET` | `tools/fss/config.ts` |
| migration | `MIGRATION_DATABASE_SECRET`, `FSS_RUNTIME_DATABASE_SECRET_ARN` | unchanged |
| nothing | `research-provider-credentials` | no reader in `apps/` or `packages/` |

## Decision

`infra/modules/cluster` names an allow-list for each process and builds each definition's
`secrets` block from it. The database entries still arrive through the two named inputs.
- **API:** Gmail client, sign-in client, session-signing key and device-credential
  pepper. Nothing reads the pepper yet, but it is sign-in material. The brief keeps the
  API's authentication secrets, so it stays there and nowhere else.
- **Worker:** Gmail client, plus the classifier key, which only the worker uses (it is
  the only process that runs `classify.reply`). The key is removed from the API, which
  does not read it.
- **Operations:** the Gmail client.
- **Drill:** the Gmail client and the migration credential.
- **Nobody:** `research-provider-credentials`. Nothing in `apps/` or `packages/` reads
  it, production allows research `none` only, and no adapter takes a credential. The
  entry is still created and filled; `unread_secret_names` names it so the plan knows
  the omission is deliberate.

A precondition on the API task definition refuses a plan with an application secret
that no list names, the unread list included. A new entry in `infra/modules/secrets`
must be given to its reader, not quietly handed to nobody.

**The name a secret arrives under.** The ECS `secrets` block names the environment
variable. The classifier reads `FSS_LLM_CLASSIFIER_API_KEY`
(`CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES` in
`packages/domain/classification/anthropicClient.ts`), but the key was injected as
`llm-classifier-api-key`. So the deployed worker never had a classifier and
`classify.reply` stayed unclaimed. `secret_environment_names` in the cluster maps the
entry to the name the classifier reads. The worker's `DEPLOYMENT_ENVIRONMENT_VARIABLES`
now says the same, and `test/release/processSecrets.check.ts` holds the three equal.

**Production only.** The classifier has no recorded seam: a worker that holds a key
calls the provider with it. The rehearsal's fill step puts a fixture in the entry
(`rehearsal-<hex>`), and the rehearsal runs on live dependencies. So a rehearsal worker
handed the key would send the drill's fixture replies to the provider under a key that
cannot work, and every `classify.reply` would fail. The new cluster variable
`worker_reads_classifier_key` (default false) gates the injection, and the stack sets it
to `local.is_production`. A rehearsal worker stays exactly as it was, with no classifier.

**What production does after this deploys.** The worker composes the classifier and
claims `classify.reply` for replies that need a second opinion, within the workspace's
daily cap. It sends each one to the provider under the key in
`fss-prod/llm-classifier-api-key`. If that entry holds a real key, this is the designed
behaviour, off since the cutover because of the name mismatch. If it holds a
placeholder, each `classify.reply` fails its attempts and dies, and
`dead_job_unresolved` warns an hour later. `FSS_CLASSIFIER=off` in the worker environment
is the documented off switch. No root sets it today.

The execution-role policies do not change. The container runs as the task role, so it
can only see what its definition injects. The execution role's wider read is used only
by the ECS agent at task start. Narrowing it too would be a separate IAM change with no
effect on what a process holds.

## Not changed

`docs/greenfield/processes.md` still says every secret arrives under its logical name.
The coordinator left that file's prose for a later lane.
