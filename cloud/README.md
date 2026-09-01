# Callie Lead Sourcing System — Cloud

Terraform scaffold for the cloud side of the sourcing pipeline: SES inbound
mail, S3 raw-mail + SourceEvent inbox buckets, DynamoDB tables, IAM, budgets,
and the placeholder mail-parse Lambda.

Target account: `326255650484` (shared, no Org), region `us-east-1`.

## Layout

```
cloud/
  terraform/            # all infrastructure (local backend for now)
  lambdas/mail-parse/   # TypeScript stub bundled with esbuild
```

## Naming and tagging conventions (shared account!)

- Every resource name is prefixed `callie-sourcing-`.
- Every IAM role/user/policy lives under path `/callie-sourcing/`.
- Every resource carries tags `Project=callie-sourcing` and
  `ManagedBy=terraform` (enforced via provider `default_tags`).
- Buckets are suffixed with the account id to guarantee global uniqueness.
- Never touch resources outside this namespace.

## Prerequisites

- Terraform >= 1.9
- Admin credentials: `AWS_PROFILE=default` (aws CLI at `/opt/homebrew/bin/aws`)
- Node 24 for the Lambda build: prefix `PATH="/opt/homebrew/opt/node@24/bin:$PATH"`

## Build the Lambda bundle (required before plan/apply)

The archive provider zips `lambdas/mail-parse/dist/` at plan time, so build first:

```sh
cd cloud/lambdas/mail-parse
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm install
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run build   # typechecks, then esbuild -> dist/handler.js
```

## Init / plan / apply

```sh
cd cloud/terraform
terraform init                          # local backend for now
terraform plan -out=tfplan
AWS_PROFILE=default terraform apply tfplan
```

Override the placeholder notification email before a real apply, e.g. in
`terraform.tfvars` (gitignored):

```hcl
budget_notification_email = "you@usecallie.com"
```

Remote state: an S3 backend block is commented out in `versions.tf`. Create
the state bucket + lock table, uncomment, then `terraform init -migrate-state`.

## Manual steps after apply

1. **Activate the SES receipt rule set.** Terraform creates
   `callie-sourcing-inbound` but does not activate it, because SES allows only
   one active rule set per account and this account is shared. Check first,
   then activate:

   ```sh
   aws ses describe-active-receipt-rule-set   # confirm nothing else is active
   aws ses set-active-receipt-rule-set --rule-set-name callie-sourcing-inbound
   ```

   (Alternatively uncomment `aws_ses_active_receipt_rule_set` in `ses.tf`.)

2. **Create the app-inbox access key manually** (deliberately NOT in Terraform
   so the secret never enters TF state), then store it in the Mac app's
   Keychain:

   ```sh
   aws iam create-access-key --user-name callie-sourcing-app-inbox
   ```

3. **Activate the `Project` cost allocation tag** in the Billing console
   (one-time) so the budget's tag filter matches spend.

## SES sandbox note

Inbound receiving works fine while the account is in the SES sandbox.
Production access is only needed for **outbound sending**, which this stack
does not do. Domain verification for `in.usecallie.com` happens automatically
via the Route53 TXT record Terraform creates.

## Budgets

`budgets.tf` defines a $50/month cost budget filtered by
`Project=callie-sourcing` with an email notification at 80% actual spend.
External data-vendor spend (cap $20/mo, alarm at $15) is billed outside AWS
and is tracked separately, not via AWS Budgets.
