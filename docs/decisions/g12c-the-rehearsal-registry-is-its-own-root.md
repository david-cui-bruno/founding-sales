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

Nothing has been applied. In particular: whether `fss-rh-deploy`'s policy, written for
ephemeral run resources, permits `ecr:CreateRepository` on `fss-rh-api` — it should,
since the condition is on the `fss-rh-*` name — and whether an ECR lifecycle policy
retaining thirty tagged images is enough history for the rollback path when several
releases are rehearsed in a week.
