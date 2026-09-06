# Callie Lead Sourcing System — Cloud

Terraform source for the cloud side of the sourcing pipeline: SES inbound mail,
S3 raw-mail and SourceEvent inbox buckets, DynamoDB tables, IAM, budgets, the
mail parser, eight scheduled functions, and their shared package.

Target account: `326255650484` (shared, no Org), region `us-east-1`.

## Layout

```
cloud/
  terraform/                         # infrastructure source
  lambdas/mail-parse/                # inbound email parser
  lambdas/adapter-pvd-taxroll/       # monthly Providence tax-roll source
  lambdas/adapter-boston-rentsmart/  # daily Boston RentSmart source
  lambdas/adapter-boston-assessments/# monthly Boston assessments source
  lambdas/scorer/                    # quarter-hour scoring source
  lambdas/resolver/                  # hourly entity resolution source
  lambdas/enricher/                  # quarter-hour approved enrichment source
  lambdas/suppression-sync/          # quarter-hour suppression membership sync
  lambdas/schedule-watchdog/         # daily monthly schedule-health watchdog
```

## Naming and tagging conventions (shared account!)

- Every resource name is prefixed `callie-sourcing-`.
- Every IAM role, user, and policy lives under path `/callie-sourcing/`.
- Every resource carries tags `Project=callie-sourcing` and
  `ManagedBy=terraform` through provider `default_tags`.
- Buckets are suffixed with the account id to guarantee global uniqueness.
- Never touch resources outside this namespace.

## Local source verification only

Implementation-time verification is intentionally limited to static source
checks and formatting. It must not initialize providers, inspect state, contact
the shared account, enable either safety gate, or send notifications.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run lint:tracked
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:lambdas
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:secrets
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
tofu fmt -check -recursive cloud/terraform
```

These commands require Node24.20.0 and separately installed lockfiles for all
**ten** Lambda packages. Install shared first, then each of the nine function
packages with its own `npm ci --prefix cloud/lambdas/<package>`, using the same
Node PATH prefix above. See the root README for the tracked lockfile install
loop. The verifier does not install dependencies and runs no deployments or
provider calls. Shared runs typecheck/test; every function also builds.
Tracked lint includes source/configuration, not Lambda dist or dependencies.
Gitleaks8.30.1 history scanning does not exclude generated paths, while context
scanning includes built Lambda bundles but never local Terraform state/inputs.
CI/release files are source-only gates, not authorization to execute remotely.

Live planning is deferred until trusted managed state and managed secret
identifiers exist. It needs separate founder approval, must keep both gates
false, use restrictive `umask 077`, require a human-readable unsaved plan only,
prove zero destroy and zero replacement, and retain a sanitized summary only.
This hold point implies no apply.

Saved plans, JSON rendering, raw Terraform secret variables, and
backend-disabled create-only plans are forbidden as proof of live safety.
Provider initialization, validation, state or plan display, application, AWS
CLI or SDK access, schedule enablement, and notification enablement are outside
this source-verification workflow. No apply is authorized by this guidance.

## Deferred live rollout requirements

Any future live rollout requires a separately approved runbook and trusted
managed state. Before that approval, the operator must confirm the shared-account
namespace, managed secret identifiers, notification recipient, SES receipt-rule
ownership, and the existing app-inbox credential handling. Access-key material
must remain outside Terraform state and in the Mac app's Keychain.

The `schedules_enabled` and `scheduled_health_alerts_enabled` gates remain false
through source verification and through any separately approved baseline plan.

## Hold Point 1: managed secrets and remote state

Task 9 prepares only reversible source. Lambda configuration contains the public
identifiers `TRACERFY_API_KEY_PARAM`, `NTFY_TOPIC_PARAM`, and `HMAC_SALT_PARAM`.
Encrypted values are looked up from SSM once per invocation and are never stored
in Terraform variables or state. The committed examples contain no replacement
values. No apply is authorized by this preparation.

Stop before any operational step. Obtain explicit founder confirmation, then use
this staged order without combining stages:

Before either bootstrap, create the one supported operator receipt directory at
canonical `$HOME/.callie-bootstrap-receipts`. Flexible receipt directories are
not supported. The directory must already exist, be a real nonsymlink directory,
be owned by the current effective UID, and have exact mode `0700`:

```bash
install -d -m 0700 "$HOME/.callie-bootstrap-receipts"
test ! -L "$HOME/.callie-bootstrap-receipts"
test "$(stat -f '%HT' "$HOME/.callie-bootstrap-receipts")" = "Directory"
test "$(stat -f '%u' "$HOME/.callie-bootstrap-receipts")" = "$(id -u)"
test "$(stat -f '%Lp' "$HOME/.callie-bootstrap-receipts")" = "700"
```

Verify every path component from `/` through that canonical directory before
invoking either bootstrap. Each component must be a real nonsymlink directory,
must be owned by root or the current effective UID, and must have no group or
other write bit. Inspect `ls -lde` output for every component as well: any `allow ACL`
entry is privacy-expanding and must be removed. A `deny-only ACL`, including the
standard macOS home entry `group:everyone deny delete`, is permitted.

Supply each bootstrap a receipt path with one non-dot basename directly inside
the exact directory, such as
`$HOME/.callie-bootstrap-receipts/terraform-state.receipt`. The state bootstrap
canonicalizes `$HOME` and the supplied parent, requires that exact match, and
repeats the complete ownership, mode, symlink, and ACL chain verification before
temporary creation or AWS behavior. Protection from other local users applies
only when the full chain passes. Hostile same-UID or root compromise is explicitly
out of scope.

1. **Stage A: prepare and verify remote state storage.** Bootstrap the
   encrypted/versioned/private state bucket and lock table first. Retain and
   inspect the recovery receipt, activation waits, and postcondition evidence.
   Verify the backend configuration names the exact reviewed state-key ARN.
2. **Stage B: obtain a second explicit confirmation and migrate trusted state.**
   Only after Stage A succeeds, obtain a second explicit confirmation before
   `tofu init -migrate-state`. Compare state serial and resource count before
   and after migration, verify locking, and retain private rollback evidence.
   Verify the actual state object with the approved metadata-only check below.
3. **Stage C: prepare and verify the runtime key.** Run the dedicated key
   bootstrap through the approved operator path. It creates a durable pending
   receipt before AWS creation, tags the key with its unique run identity, and
   retains enough evidence to reconcile a lost create-key or create-alias response.
   If preparation stops ambiguously, do not retry `--prepare`; run `--recover` with
   that same private receipt. Recovery deletes only an alias proven to target the
   tagged key, verifies alias absence, schedules only the exactly tagged key for
   deletion, verifies `PendingDeletion` plus a deletion date, and claims cleanup
   only after every check succeeds. Retain a verified mode-0600 receipt, verify
   the alias target and enabled rotation, and stop. Terraform reads this
   pre-existing alias; it does not create or replace the key during cutover.
4. **Stage D: enter and prevalidate all three parameters.** Enter Tracerfy, ntfy,
   and membership-HMAC values directly into encrypted SSM under the prepared
   key. Run `bootstrap-runtime-secret-key.sh --verify-parameters` to confirm each
   identifier uses that exact key and can be decrypted while displaying no
   value. A missing optional ntfy parameter is allowed at runtime, but Hold Point
   prevalidation deliberately requires all three before infrastructure cutover.
5. **Stage E: state-aware IAM and Lambda identifier cutover.** Only after the
   trusted-state migration and its state-object postcondition verification,
   create a human-readable unsaved plan with restrictive `umask 077`,
   `schedules_enabled=false`, and `scheduled_health_alerts_enabled=false`.
   Prove zero destroy and zero replacement. Retain only a sanitized summary.
   In a separately approved apply, cut over IAM and identifier-only Lambda
   configuration with both gates false, then invoke bounded checks and inspect
   only redacted logs.

**Rollback:** keep schedules false and retain the previously deployed Lambda
versions/configuration until Stage E verification completes. If any canary or
decrypt check fails, restore those prior versions/configuration, do not delete or
re-encrypt parameters, and investigate against the private receipts. Never roll
back by placing a secret value in Terraform or Lambda environment configuration.

The state bootstrap is the first operational stage of that later approved workflow. It
refuses existing names, records a mode-0600 recovery receipt, immediately applies
bucket controls, cleans up resources created by a failed run, waits for lock-table
activation, and verifies public-access blocking, versioning, encryption key,
table SSE, and readiness before success. An uncatchable interruption can still
leave a partial resource. Inspect the receipt and run `--recover` before retrying
or migration. Do not run either bootstrap during source verification.

The backend configuration must include the exact reviewed state-key ARN as
identifier-only `kms_key_id`. The backend operator identity needs S3 access scoped
to the reviewed bucket/object and exact KMS permissions `kms:Encrypt`,
`kms:Decrypt`, `kms:GenerateDataKey`, and `kms:DescribeKey` on that state-key ARN.
Do not grant those KMS actions on `*` or on the runtime-secret key.

After the protected backend is reviewed, Stage B requires the second confirmation
and trusted-state migration before any IAM/Lambda plan or cutover. Verify the
actual state object rather than relying on
bucket defaults: run an approved `aws s3api head-object` for the exact reviewed
bucket and `cloud/terraform.tfstate` key, inspect only `ServerSideEncryption` and
`SSEKMSKeyId`, require `ServerSideEncryption` to equal `aws:kms`, and require
`SSEKMSKeyId` to equal the exact reviewed state-key ARN. Do not accept an alias,
SSE-S3/AES256, another key ARN, or missing metadata. Schedule enablement requires
a later health review.

## Staged schedule rollout

Never enable schedules during source verification. A future rollout requires a
separate approval and two applies that must not be combined:

1. Apply `schedules_enabled=true` while keeping
   `scheduled_health_alerts_enabled=false`. Verify current completion metrics and
   watchdog heartbeats arrive for every expected cadence. Wait until all
   missing-success alarms reach a known OK baseline from current observations.
2. Only after that baseline is reviewed, obtain separate approval for the health-action
   change. That approval does not preserve or authorize reuse of the observed baseline.
3. Immediately before the health-action apply, while health actions remain disabled,
   perform a fresh pre-apply check as the first step of a single tightly bounded
   precheck/apply/postcheck sequence. Re-read current completion metrics and watchdog
   heartbeats for every expected cadence, and require every affected missing-success
   alarm to be exactly `OK` from those current observations. The operator must not
   reuse the approval-time baseline. If the apply and immediate postcheck cannot follow
   without intervening work or delay, expire the precheck and repeat it before applying.
   If any alarm is `ALARM`, `INSUFFICIENT_DATA`, stale, or otherwise non-OK, abort
   before apply, leave `scheduled_health_alerts_enabled=false`, and do not attach
   notification actions.
4. From a successful fresh precheck, immediately use the separate approved apply with
   `scheduled_health_alerts_enabled=true`.
5. Immediately after the apply, verify each affected alarm's `alarm_actions` contains
   exactly the reviewed SNS topic ARN and no additional actions, and require every
   affected missing-success alarm remains exactly `OK`.

If any alarm is non-OK after apply, explicitly fail the rollout and do not claim
transition coverage. Use a separately approved manual incident-notification path for
the current condition rather than relying on a missing state transition. Restore
current completion metrics and watchdog heartbeats until all affected alarms return to
exactly `OK`; only then accept future transition coverage.

## SES sandbox note

Inbound receiving works while the account is in the SES sandbox. Production
access is needed only for outbound sending, which this stack does not do. Domain
verification for `in.usecallie.com` is represented by the Route53 source.

## Budgets

`budgets.tf` defines a $50/month cost budget filtered by
`Project=callie-sourcing` with an email notification at 80% actual spend.
External data-vendor spend is billed outside AWS and is tracked separately.
