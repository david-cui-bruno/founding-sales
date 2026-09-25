# Cloud

The cloud side of FSS is one AWS Lambda, the delegated worker, deployed from one Terraform root. Target account `326255650484` (shared, no Org), region `us-east-1`. Worker resources keep the legacy `callie-sourcing-` name prefix, the `/callie-sourcing/` IAM path and the `Project=callie-sourcing` / `ManagedBy=terraform` tags so the deployed worker's names stay stable; never touch resources outside that namespace.

## Layout

```
cloud/
  lambdas/delegated-worker/             # the worker Lambda: handler, DynamoDB store, pairing operator CLI (OPERATOR.md)
  terraform/modules/delegated-worker/   # the single worker implementation
  worker-terraform/                     # the only Terraform root; calls the module (README.md)
  scripts/bootstrap-terraform-state.sh  # one-time create/recover of the shared state bucket and lock table (already created)
```

## Legacy sourcing pipeline (removed)

Until 17 September 2026 this directory also held the public-record lead-sourcing pipeline: a Terraform root at `cloud/terraform/*.tf` (SES inbound mail, S3 raw-mail and inbox buckets, DynamoDB tables, IAM, budgets, alarms, dashboard, schedules) and nine Lambda packages (the inbound mail parser, three public-record adapters, the scorer, resolver, enricher, suppression sync and the schedule watchdog). David destroyed the deployed stack that day: its eight Lambdas and the watchdog, their schedules, five tables (on-demand backups taken first), two buckets, the SES identity and its DNS records. The runtime SSM parameters and the runtime KMS key were read, not managed, by Terraform and were left in place. The source, its contract documents (`CONTRACT.md`, `VERIFIED_SOURCES.md`), the runtime-secret-key bootstrap and `tests/infrastructure/terraformHardening.test.ts` were removed in the batch that followed; Git history before that commit has the full source.

## Source verification only

Nothing here initializes providers, reads state, contacts AWS or deploys. Install the root and the one tracked Lambda lockfile, then run the offline gates:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
npm ci --no-audit --no-fund
npm ci --prefix cloud/lambdas/delegated-worker --no-audit --no-fund
npm run legacy:verify:lambdas            # delegated-worker (typecheck, test, build)
npx vitest run tests/infrastructure
npm run legacy:lint:tracked
npm run legacy:typecheck
```

`verify:lambdas` discovers tracked `cloud/lambdas/*/package.json` manifests, so CI carries no package list. Terraform formatting, validation and the mock-provider plan tests for the worker root are described in `worker-terraform/README.md`.

## Deployment

Deployment is David's decision, taken from `cloud/worker-terraform/` with a reviewed `backend.hcl` and a built `cloud/lambdas/delegated-worker/dist`. Read that root's README first: backend and state-ownership review is mandatory, the worker is off by default, and enabling it is not a grant, send approval or budget approval. The pairing operator (`lambdas/delegated-worker/OPERATOR.md`) issues desktop bootstraps separately; it does not deploy.
