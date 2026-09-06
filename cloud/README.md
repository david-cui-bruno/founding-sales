# Callie Lead Sourcing System — Cloud

Terraform source for the cloud side of the sourcing pipeline: SES inbound mail,
S3 raw-mail and SourceEvent inbox buckets, DynamoDB tables, IAM, budgets, the
mail parser, and seven scheduled sourcing functions.

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
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/schedule-watchdog && npm run typecheck && npm test && npm run build)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
tofu fmt -check -recursive cloud/terraform
```

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

Before either bootstrap, create a dedicated receipt directory owned only by the
current operator. The directory must already exist, must be a real nonsymlink
directory owned by the current effective UID, and must have exact mode `0700`:

```bash
install -d -m 0700 "$HOME/.callie-bootstrap-receipts"
test ! -L "$HOME/.callie-bootstrap-receipts"
test "$(stat -f '%HT' "$HOME/.callie-bootstrap-receipts")" = "Directory"
test "$(stat -f '%u' "$HOME/.callie-bootstrap-receipts")" = "$(id -u)"
test "$(stat -f '%Lp' "$HOME/.callie-bootstrap-receipts")" = "700"
```

Supply each bootstrap a receipt path with one non-dot basename directly inside
that private directory, such as
`$HOME/.callie-bootstrap-receipts/terraform-state.receipt`. Verify this boundary
before invoking either bootstrap. The state bootstrap rejects a missing, symlinked,
differently owned, group-writable, or other-writable receipt directory before any
bootstrap behavior. This boundary protects against other local users. It does not
claim protection from hostile code running as the same UID.

1. **Stage A: prepare and verify the runtime key.** Run the dedicated key
   bootstrap through the approved operator path. Retain its mode-0600 receipt,
   verify the alias target and enabled rotation, and stop. Terraform reads this
   pre-existing alias; it does not create or replace the key during cutover.
2. **Stage B: enter and prevalidate all three parameters.** Enter Tracerfy, ntfy,
   and membership-HMAC values directly into encrypted SSM under the prepared
   key. Run `bootstrap-runtime-secret-key.sh --verify-parameters` to confirm each
   identifier uses that exact key and can be decrypted while displaying no
   value. A missing optional ntfy parameter is allowed at runtime, but Hold Point
   prevalidation deliberately requires all three before infrastructure cutover.
3. **Stage C: cut over IAM and Lambda identifiers.** Review the exact plan with
   both schedule gates false. Only after Stage B succeeds may the IAM conditions
   and identifier-only Lambda environment changes be applied. Invoke bounded
   checks and inspect only redacted logs.

**Rollback:** keep schedules false and retain the previously deployed Lambda
versions/configuration until Stage C verification completes. If any canary or
decrypt check fails, restore those prior versions/configuration, do not delete or
re-encrypt parameters, and investigate against the private receipts. Never roll
back by placing a secret value in Terraform or Lambda environment configuration.

The state bootstrap is an operator aid for that later approved workflow. It
refuses existing names, records a mode-0600 recovery receipt, immediately applies
bucket controls, cleans up resources created by a failed run, waits for lock-table
activation, and verifies public-access blocking, versioning, encryption key,
table SSE, and readiness before success. An uncatchable interruption can still
leave a partial resource. Inspect the receipt and run `--recover` before retrying
or migration. Do not run either bootstrap during source verification.

After the protected backend is reviewed, obtain a second explicit confirmation
before `tofu init -migrate-state`. Compare state serial and resource count before
and after migration, verify locking, and retain private rollback evidence before
removing local state. Schedule enablement requires a later health review.

## SES sandbox note

Inbound receiving works while the account is in the SES sandbox. Production
access is needed only for outbound sending, which this stack does not do. Domain
verification for `in.usecallie.com` is represented by the Route53 source.

## Budgets

`budgets.tf` defines a $50/month cost budget filtered by
`Project=callie-sourcing` with an email notification at 80% actual spend.
External data-vendor spend is billed outside AWS and is tracked separately.
