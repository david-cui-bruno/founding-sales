# G1: how production and rehearsal are structurally isolated

**Date:** 19 September 2026 · **Lane:** G1 infrastructure · **Spec:** section 2 ("Terraform state"), 4.1, Appendix G scenario 39.

The spec says production and each rehearsal run use distinct state keys, locks, deployment roles, secrets and resource namespaces, and that rehearsal teardown cannot address production resources. The spec does not say how. This is how.

## The single lever

Everything in a stack derives its name from one input, `name_prefix`. There is no resource anywhere under `infra/` whose name is written without it. So if the two roots cannot share a `name_prefix`, they cannot share a resource name, and therefore cannot share an ARN, an IAM role name, a secret name, a bucket, a log group, an alarm or a KMS alias.

Two disjoint namespaces:

| Root | Namespace | Enforced by |
|---|---|---|
| production | exactly `fss-prod` | `var.name_prefix` validation in the root, plus a precondition in the stack module |
| rehearsal | `fss-rh-<run>`, 3 to 18 characters after the prefix | `var.name_prefix` validation in the root, plus a second validation that refuses anything starting `fss-prod`, plus the same stack precondition |

`fss-prod` and `fss-rh-` differ at their fifth character, so no string can satisfy both patterns.

## Why the guard is in four places and not one

1. **Root variable validation** is what an operator hits first, before any plan runs, and it is what `expect_failures` in the offline tests can address. This is the layer the acceptance criterion names.
2. **A precondition in the stack module** (`terraform_data.environment_guard`) catches the case where someone writes a third root, or calls the stack module directly, and forgets the validation. It also ties `environment` to `destroyable`, to Multi-AZ and to the 35-day retention, so a production stack cannot be made destroyable or single-AZ from any caller.
3. **Literals in each root's `main.tf`.** `environment` and `destroyable` are not variables. The production root passes `environment = "production"` and `destroyable = false`; the rehearsal root passes `"rehearsal"` and `true`. No `-var` on the command line can change either.
4. **Whole-inventory assertions in the offline tests.** Each root exports `resource_names`, a list of every name the stack claims in the shared account, and its test asserts that every entry carries its own namespace and that none contains the other's. That is the "no resource name or ARN in the rehearsal plan can equal a production one" check, done over the real list rather than over one example.

## The three things Terraform alone cannot enforce

1. **State.** Each root has its own `backend.hcl` with its own key under the shared bucket: `fss/greenfield/production/terraform.tfstate` and `fss/greenfield/rehearsal/<run>/terraform.tfstate`. Terraform cannot assert this from inside the configuration, so the CI workflow parses both files and fails if the keys are equal or outside their expected path. CI also fails if either file names a legacy key.

2. **IAM.** Each root's provider assumes a distinct role: `fss-prod-deploy` and `fss-rh-deploy`. The roles do not exist yet; the apply runbook specifies that `fss-rh-deploy`'s policy is scoped to `fss-rh-*` on every statement that supports a resource ARN. **This is the only layer that makes Appendix G scenario 39 true against a real cloud rather than only in a plan**, and it is the one layer this lane cannot build, because it has no credentials. It is the first item in the runbook for a reason.

3. **Google Cloud.** The rehearsal root's `enable_gmail_push` defaults to false and refuses to turn on without its own `gcp_project_id`. A rehearsal run must never publish into the production project. Asserted offline.

## What was rejected

- **Naming by convention, checked in review.** The brief explicitly asks for structural isolation, and a convention is not one.
- **Separate AWS accounts.** That is the right long-term answer and it would make most of the above unnecessary. The repository documents a single shared account with no Organization, so it is out of scope for this lane; it should be reconsidered before a second external workspace exists.
- **A `naming` module that computes the prefix from an environment enum.** It moves the guard one level further from the operator and makes the `expect_failures` target unreachable from a root test, for no extra safety.
