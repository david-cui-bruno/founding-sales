# The rehearsal repositories are their own root, applied once

**Lane:** G12c · **Spec:** 16.2, Appendix G 39 · **Files:** `infra/roots/rehearsal-registry/*`, `infra/modules/stack/{main,variables,outputs}.tf`, `infra/roots/rehearsal/{main,variables}.tf`, `infra/scripts/{offline-gate.sh,rehearsal-common.sh,rehearsal-prefix-guard.sh}`, `.github/workflows/greenfield-infra.yml`, `test/release/scenario39.check.ts`

## The circle

The per-run rehearsal root called `infra/modules/stack`, which creates an ECR
repository per service named from the stack's prefix. For a run called
`fss-rh-20260920` those are `fss-rh-20260920-api` and `fss-rh-20260920-worker`.

Three things make that impossible rather than merely awkward:

1. **The images are pushed before the run exists.** `docs/greenfield/release.md` 2.1 has
   David push the digests from his Mac; the workflow then applies a root that deploys
   them *by digest*. A repository created by that apply cannot be the one the images
   were pushed to an hour earlier.
2. **The workflow's secrets name stable repositories.** `FSS_REHEARSAL_API_REPOSITORY`
   and `FSS_REHEARSAL_WORKER_REPOSITORY` are environment secrets: one value each, set
   once, ending `/fss-rh-api` and `/fss-rh-worker`. There is no per-run value they
   could hold.
3. **A per-run repository is destroyed with the run.** Teardown runs `if: always()`, and
   `force_delete` is `var.destroyable`, so the images would go with it — including the
   earlier compatible binaries 4.2's preferred rollback depends on.

## The decision

**A third root, `infra/roots/rehearsal-registry`**, applied once by `fss-rh-deploy`,
holding exactly two repositories: `fss-rh-api` and `fss-rh-worker`.

> **Who applies it, corrected by G12d (20 September 2026).** Not the operator. This
> lane's runbook entry had David run `terraform apply` here; he was refused
> `sts:AssumeRole`, because `fss-rh-deploy` trusts the GitHub OIDC provider and the
> subject `repo:david-cui-bruno/founding-sales:environment:rehearsal` alone. The trust
> stays as it is — it is this scenario's whole point — and the apply moved into
> `.github/workflows/greenfield-rehearsal-registry.yml`, a dispatch-only workflow with
> one job in the `rehearsal` environment, plan-only by default and behind a plan guard
> that refuses any type this root does not create, any name outside `fss-rh-` and any
> destroy or replacement. `docs/decisions/g12d-the-once-only-registry-apply-is-a-workflow.md`.

* `name_prefix` is a **local, not a variable**. The workflow's secrets name those two
  strings; a root that could be applied under another prefix would produce repositories
  nothing points at. There is no `-var` that changes what this root creates.
* Everything else is `infra/modules/registry`'s defaults, which are production's:
  immutable tags, scan on push, untagged layers expired at seven days, thirty tagged
  images retained. Rollback in rehearsal wants the same history rollback in production
  does, and the root test asserts the three settings rather than trusting the shared
  module not to drift.
* `force_delete = false`. These repositories hold the images every past release was
  rehearsed on; a `terraform destroy` that emptied them quietly would be worse than one
  that failed on a repository that is not empty.

**A `create_registry` flag on `infra/modules/stack`**, defaulting `true` (production
keeps its own registry) and passed `false` by the per-run rehearsal root. The two
registry outputs and the `resource_names` inventory return empty rather than failing
when the module is not created, so the isolation test can assert the absence.

### The one address that already exists, and the `moved` block

Production is not greenfield state any more. David ran
`terraform apply -target=module.stack.module.registry` in `infra/roots/production` at
commit 71d84e00 to bootstrap `fss-prod-api` and `fss-prod-worker` before the first
image push, so production state holds that module at its **un-counted** address.

Adding `count` renames it to `module.stack.module.registry[0]`. Terraform reads a
renamed address as one thing destroyed and another created, and for an ECR repository
that means deleting the images every release record identifies — including the earlier
compatible binaries 4.2's preferred rollback depends on. A `moved` block inside
`infra/modules/stack`

```hcl
moved {
  from = module.registry
  to   = module.registry[0]
}
```

migrates the state within the plan: the two repositories appear under "has moved to"
and then report no changes. The rehearsal roots are unaffected — their state is created
fresh per run — and both root test suites stay green (16 and 16).

The runbook (2.1, 2.2 and the 3.2 plan checklist) and `release.md` 4 all say the same
thing in the operator's words: **a production plan that proposes to destroy an ECR
repository is not to be applied.** That instruction outlives this block; it is the
check that catches the next person who removes it.

**The per-run root now validates its image variables.** `api_image` must end
`/fss-rh-api@sha256:<64 hex>` and `worker_image` `/fss-rh-worker@sha256:<64 hex>`. The
digest is the one proposed for production; the repository it is pulled from is not,
because `fss-rh-deploy` may read nothing outside `fss-rh-*`. Without the validation a
production repository URL fails as an ECR authorization error several minutes into a
deployment; with it, it fails at plan time naming the variable.

## A third state key, and why it is not under `fss/greenfield/rehearsal/`

A run's state key is `fss/greenfield/rehearsal/<run>/terraform.tfstate`, and `registry`
is a legal run suffix — `fss-rh-registry` matches the prefix pattern. A registry state
key of `fss/greenfield/rehearsal/registry/terraform.tfstate` would therefore be
claimable by a run, whose teardown would destroy the two durable repositories.

So the key is `fss/greenfield/rehearsal-registry/terraform.tfstate`, outside the per-run
space entirely. The offline gate and `greenfield-infra.yml` both assert three distinct
keys, each under its own prefix, and that the registry key is not inside the per-run
space. `scenario39.check.ts` asserts the gate does.

## What the prefix guard had to learn

Appendix G 39's script half asserts that a rehearsal touched nothing named `fss-prod`.
Until now every rehearsal resource carried the run, so "carries the run" and "is a
rehearsal resource" were the same statement. They are not any more: `fss-rh-api` and
`fss-rh-worker` are rehearsal-namespace resources that carry no run.

`rehearsal_classify_name` in `rehearsal-common.sh` returns one of four verdicts —
`production`, `rehearsal-run`, `rehearsal-stable`, `foreign` — and fails for the first
and the last. The guard's `after` phase runs it over the run's own name, both stable
names, a production name that must be refused, and another run's name that must also be
refused. It runs in dry mode too, so every pull request exercises both branches without
a credential, and the report line now carries `stable_repositories=rehearsal`.

The alternative — teaching the guard a list of names to ignore — was rejected because an
ignore list is silent about *why* a name is ignored, and the failure this guards against
is precisely a future edit that broadens the production inventory filter and starts
seeing them.

## What this could not verify

One targeted apply has happened (the production registry, above); nothing else has.
In particular: whether `fss-rh-deploy`'s policy, written for ephemeral run resources,
permits `ecr:CreateRepository` on `fss-rh-api` — it should, since the condition is on
the `fss-rh-*` name — and whether an ECR lifecycle policy retaining thirty tagged
images is enough history for the rollback path when several releases are rehearsed in a
week.

And the `moved` block itself, which cannot be tested offline: `terraform test` plans
against mocked providers with no prior state, so nothing in this repository exercises
the migration. What is verified is that both roots still plan and validate with the
block present. The proof is the first production plan, and the instruction to stop on a
proposed ECR destroy is what makes a wrong answer survivable.
