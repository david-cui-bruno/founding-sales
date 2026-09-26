# The provider assumes the deployment role only when the session is not already it

**Lane:** G12e · **Spec:** 16.2, Appendix G 39 · **Files:** `infra/roots/{production,rehearsal,rehearsal-registry}/{providers.tf,variables.tf,tests}`, `infra/scripts/rehearsal-common.sh`, `infra/scripts/rehearsal-caller-identity.sh`, `infra/scripts/rehearsal-teardown.sh`, `infra/scripts/rehearsal-registry-guard.sh`, `.github/workflows/greenfield-release.yml`, `.github/workflows/greenfield-rehearsal-registry.yml`, `test/release/scenario39.check.ts`, `scripts/releaseMutationCheck.mjs`, `docs/greenfield/infra-apply-runbook.md`, `docs/greenfield/release.md`, `docs/archive/decisions/g12d-the-once-only-registry-apply-is-a-workflow.md`

## The failure this answers

All three roots carried an unconditional provider block:

```hcl
assume_role {
  role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${var.deployment_role_name}"
  session_name = "fss-rehearsal-terraform"
}
```

Locally that is exactly right: David's user assumes `fss-prod-deploy`, and the
provider is the thing that does the assuming (`infra-apply-runbook.md` 3.2). In CI it
is wrong. `aws-actions/configure-aws-credentials` has already assumed `fss-rh-deploy`
through GitHub OIDC before Terraform starts, so the provider asks STS to assume
`fss-rh-deploy` **from a session that already is `fss-rh-deploy`**. Role chaining onto
the same role succeeds only if the role's trust policy admits itself, and
`fss-rh-deploy` trusts the GitHub OIDC provider and the subject
`repo:david-cui-bruno/founding-sales:environment:rehearsal` and nothing else — which is
Appendix G 39's "distinct roles" clause made real and the one protection in this design
that does not depend on somebody reading a plan correctly.

The failure arrives at **provider configuration during `plan`**, not at `init`: the S3
backend authenticates with the ambient credentials and has no `assume_role` of its own,
so `init` succeeds and the plan is refused `sts:AssumeRole`. Both credentialed
workflows have this shape: `greenfield-release.yml` (the rehearsal apply, the teardown)
and `greenfield-rehearsal-registry.yml` (the one registry apply).

## The decision

**The trust policy does not change. The assumption becomes conditional.**

`assume_deployment_role`, a `bool` root variable in all three roots, **defaulting to
`true` everywhere**. The two rehearsal workflows pass `-var=assume_deployment_role=false`
because their session already holds the role. Production passes nothing: section 3.2 is
unchanged.

The default is the part worth defending. False would be the "correct" default for the
two roots that are only ever applied by CI — and it would mean that a caller who
forgot the flag acted as whatever ambient credential the shell or the runner happened
to hold. True means a forgotten flag is an `sts:AssumeRole` refusal: loud, immediate,
and the boundary working rather than a silent widening of it. Acting without assuming
anything should be something a caller says out loud.

## Why a `dynamic` block, and not `role_arn = … : null`

The brief said to write `role_arn = var.assume_deployment_role ? "arn:…" : null` on the
grounds that `dynamic` is not allowed in provider blocks. **`dynamic` is allowed in
provider blocks**, and both forms were checked offline against the real provider schema
before choosing. This is a deliberate deviation from the brief and it is the only one.

The evidence, all of it from `terraform providers schema -json` with
**hashicorp/aws v5.100.0** (the version `~> 5.60` resolves to today; it is what
`infra/roots/production/.terraform.lock.hcl` records) and Terraform **1.15.8**:

* `assume_role` is a `list`-nested block whose every attribute is optional. For
  `role_arn` the schema says `"optional": true`, `"required"` absent, and the
  provider's own description of it — the sentence the registry documentation renders —
  is *"Amazon Resource Name (ARN) of an IAM Role to assume prior to making API
  calls."*
* So `role_arn = null` is accepted by the schema, and `terraform validate` passes with
  it. But the provider binary also carries the pair of strings
  `The argument %q is required, but no definition was found.` and
  `This will be an error in a future version of the provider`, which is the
  `assume_role`-without-`role_arn` diagnostic: v5 warns and proceeds, and says it will
  one day refuse. A release gate's credential path should not rest on a deprecation.
* A `dynamic "assume_role"` block whose `for_each` is empty produces a provider
  configuration with **no** `assume_role` block at all, which needs no interpretation
  by anybody. Terraform's own documentation lists `provider` among the block types
  `dynamic` may appear in, and it decodes: with a real `aws` data source present so
  that the provider body is actually decoded, `terraform validate` accepts the dynamic
  form and rejects a bogus argument in the same block, so the body was decoded against
  the provider schema rather than skipped.

Neither form can be verified further offline, because verifying the *runtime* choice
means making an STS call. What that means in practice is in "What this could not
verify".

## The flag cannot become a way to run as somebody else

`assume_deployment_role=false` moves the question "which principal is this apply?" out
of the Terraform configuration and into the job's ambient credentials. So it is
answered before Terraform is given them, by
`infra/scripts/rehearsal-caller-identity.sh`:

* it prints `aws sts get-caller-identity --query Arn` — an ARN is a public identifier
  and naming the principal is the whole point;
* it refuses anything that is not
  `arn:aws:sts::<account>:assumed-role/fss-rh-deploy/<session>`. The *shape* carries
  the evidence: an assumed-role ARN says the session assumed the role, while
  `arn:aws:iam::<account>:user/<name>` says a user did not. The old inline check in
  both workflows matched `*fss-rh-*`, which would have accepted `fss-rh-deploy-other`,
  `fss-rh-readonly` and a user whose path contained the string;
* it refuses to be pointed at a role outside `fss-rh-`. Production's applies assume
  their role in the provider and never pass this flag, so there is nothing here for
  production to use;
* it runs in the release workflow and the registry workflow immediately after the
  credential step, and again inside `rehearsal-teardown.sh` — that one runs on
  `always()`, including after a failure, so it cannot trust a step that may not have
  been reached. A teardown whose identity is wrong stops with the environment
  standing, which is the cheaper of the two mistakes.

It is tested rather than trusted. `FSS_REHEARSAL_CALLER_IDENTITY` supplies the ARN to
judge, so `test/release/scenario39.check.ts` and the release workflow's credential-free
`dry-run` job both run the real script over six identities — one accepted and five
refused, including the empty one — with no AWS call. `scripts/releaseMutationCheck.mjs`
gains two mutations: widen the ARN pattern to `.*`, and drop the flag from the release
apply; each must turn the suite red.

## What a tftest can and cannot say

Each root gained two runs (`infra/roots/*/tests/*.tftest.hcl`): the variable exists, the
default is to assume, and **the plan is identical with the flag off** — same prefix,
same role name, same resource names. That last one is the useful assertion: the flag
chooses a credential path and must never change what is created.

A tftest cannot observe the credential chain at all. `mock_provider "aws"` replaces the
provider configuration wholesale, so no `assume_role` block, no STS call and no
credential resolution is exercised by any run in this repository. The comments in the
test files say so, rather than leaving a reader to infer that a passing plan proves the
assumption was skipped.

## What this could not verify

1. **That the AWS provider really makes no STS call when the block is absent.** It is
   the same configuration as a root with no `assume_role` block at all, which is the
   ordinary case for a provider using ambient credentials, so this is as close to
   certain as an unrun thing gets — but nothing here has been run. The first CI
   rehearsal is the proof. If the plan still fails at provider configuration, the
   caller-identity step immediately above it will have printed the session ARN, and
   that line plus the STS error names the cause.
2. **That the CI session's permissions are sufficient without the assumption.** They
   are the same permissions either way — the session *is* `fss-rh-deploy` — unless the
   role's own policy grants something only to a chained session, which nothing in
   `infra-apply-runbook.md` 1.1 describes.
3. **The AWS provider major version.** `~> 5.60` keeps this on v5. If the roots ever
   move to v6, re-check this decision: v6 is where the `role_arn`-less `assume_role`
   deprecation was scheduled to become an error, and the dynamic form is chosen partly
   so that change cannot reach us.
4. Whether the `rehearsal` environment has a required reviewer (unchanged from G12d),
   and whether `fss-rh-deploy` may read and write the registry state key (unchanged
   from G12d).
