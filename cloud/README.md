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

## SES sandbox note

Inbound receiving works while the account is in the SES sandbox. Production
access is needed only for outbound sending, which this stack does not do. Domain
verification for `in.usecallie.com` is represented by the Route53 source.

## Budgets

`budgets.tf` defines a $50/month cost budget filtered by
`Project=callie-sourcing` with an email notification at 80% actual spend.
External data-vendor spend is billed outside AWS and is tracked separately.
