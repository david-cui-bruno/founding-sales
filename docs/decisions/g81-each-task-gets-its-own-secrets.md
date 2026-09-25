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
| worker | `google-gmail-oauth-client`, `DATABASE_SECRET_ARN` | `readGmailDeployment`, `bootstrap/config.ts` |
| operations (`fss`) | `google-gmail-oauth-client` (mail commands, via `readWorkerDeployment`), `DATABASE_SECRET_ARN` | `tools/fss.ts`, `tools/fss/config.ts` |
| drill (`fss drill`) | the operations set plus `MIGRATION_DATABASE_SECRET` | `tools/fss/config.ts` |
| migration | `MIGRATION_DATABASE_SECRET`, `FSS_RUNTIME_DATABASE_SECRET_ARN` | unchanged |

## Decision

`infra/modules/cluster` names an allow-list for each process and builds each definition's
`secrets` block from it. The database entries still arrive through the two named inputs.
- **API:** Gmail client, sign-in client, session-signing key and device-credential
  pepper. Nothing reads the pepper yet, but it is sign-in material. The brief keeps the
  API's authentication secrets, so it stays there and nowhere else.
- **Worker:** Gmail client, plus `llm-classifier-api-key` and
  `research-provider-credentials`. Those two belong to the worker's lanes: it is the only
  process that runs `classify.reply` and the research jobs. They are removed from the API,
  which reads neither.
- **Operations:** the Gmail client.
- **Drill:** the Gmail client and the migration credential.

A precondition on the API task definition refuses a plan with an application secret
that no list names. A new entry in `infra/modules/secrets` must be given to its reader,
not quietly handed to nobody.

The execution-role policies do not change. The container runs as the task role, so it
can only see what its definition injects. The execution role's wider read is used only
by the ECS agent at task start. Narrowing it too would be a separate IAM change with no
effect on what a process holds.

## Found while checking

The worker's classifier reads `FSS_LLM_CLASSIFIER_API_KEY`
(`packages/domain/classification/anthropicClient.ts`). The task definition injects the
entry as `llm-classifier-api-key`, and nothing maps one name to the other. So the deployed
classifier is never configured and `classify.reply` stays unclaimed. Nothing reads
`research-provider-credentials` either, and production allows research `none` only.
Both are left on the worker for the lane that wires them up.
