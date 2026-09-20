# The rehearsal registry's one apply is a workflow run, not a command in a terminal

**Lane:** G12d · **Spec:** 16.2, Appendix G 39 · **Files:** `.github/workflows/greenfield-rehearsal-registry.yml`, `infra/scripts/rehearsal-registry-guard.sh`, `.github/workflows/greenfield-release.yml` (dry run), `test/release/scenario39.check.ts`, `test/release/support/scenarioMap.ts`, `scripts/releaseMutationCheck.mjs`, `docs/greenfield/release.md`, `docs/greenfield/infra-apply-runbook.md`, `docs/decisions/g12c-the-rehearsal-registry-is-its-own-root.md`

## What happened

G12c gave the two durable rehearsal repositories their own root and the runbook told
the operator to apply it:

```bash
cd infra/roots/rehearsal-registry
terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<state key arn>"
terraform apply
```

The operator ran it and was refused `sts:AssumeRole` on `fss-rh-deploy`. That role's
trust policy names the GitHub OIDC provider and the subject
`repo:david-cui-bruno/founding-sales:environment:rehearsal`, and nothing else. No
principal on a Mac can assume it.

## The decision

**The trust policy does not change; the apply moves.** That trust is Appendix G 39's
"distinct roles" clause made real — it is the reason a rehearsal teardown cannot
address production, and it is the one protection in this design that does not depend
on anybody reading a plan correctly. Widening it to admit an admin principal would
make the scoping a convention rather than a boundary, and the thing being bought is
one apply that happens once.

So there is a second dispatch-only workflow,
`.github/workflows/greenfield-rehearsal-registry.yml`, with one job under
`environment: rehearsal`, `id-token: write`, and the same pinned actions and the same
Terraform version (`1.15.8`) the release workflow uses. The release suite asserts the
pins are the *same commits*, not merely commits: two files pinning different builds of
`configure-aws-credentials` are two credential paths.

## The problem that creates, and the guard that answers it

An apply in a terminal is read by a person before it runs. An apply in a workflow is
not read by anybody, because the plan exists only inside the run. Moving the
credential without moving the judgement would be a worse design than the one that
failed, not a better one.

Two things replace the person's eyes:

1. **`apply` is a boolean input defaulting to `false`.** The first dispatch plans,
   guards and prints the plan into the step summary and changes nothing. The operator
   reads that summary and dispatches the same workflow again, on the same commit, with
   `apply` ticked. The reading still happens; it happens between two runs instead of
   between two lines of a terminal.
2. **`infra/scripts/rehearsal-registry-guard.sh` reads `terraform show -json` and
   refuses to let an apply proceed** unless every planned resource is a type this root
   creates, every address is inside `module.registry`, every name it claims in the
   account is in the `fss-rh-` namespace (and is one of the two this root owns), and
   nothing is destroyed or replaced.

The fourth of those is the one that matters. `force_delete = false` makes a *destroy*
of a repository holding images fail, which G12c chose deliberately. It does nothing
about a **replacement** — a change to an attribute that forces new — which Terraform
proposes as delete-then-create and which would take every image past releases were
rehearsed on. The guard treats any plan containing `delete` as a refusal, including
the `["delete","create"]` pair.

### The expected types are the ones the root creates, not the ones it might

`infra/modules/registry` declares `aws_ecr_repository` and `aws_ecr_lifecycle_policy`,
and that is the whole allow-list. In particular **`aws_ecr_repository_policy` is not on
it**, although the brief suggested it might be: there is no cross-account pull here and
the rehearsal tasks pull with an execution role in the same account, so the root does
not create one. A plan that contains one is a root somebody changed, which is exactly
the plan a guard should stop. Widening the list to cover a resource nobody has written
would make the guard agree in advance with a change nobody has read.

## The state KMS key, and why it is optional

`backend.hcl` carries the bucket, the key, the region, the lock table and
`use_lockfile`; the state KMS key ARN is account-specific and G12c left it to be
supplied at init. The release workflow has no way of naming it — its rehearsal init
passes `backend.hcl` alone — so this lane adds an environment secret,
`FSS_REHEARSAL_STATE_KMS_KEY_ARN`, and makes it **optional**: with it, init passes
`-backend-config=kms_key_id=…`; without it, the bucket's default encryption applies,
which is what the per-run rehearsal root's init already does today. The workflow prints
*whether* it was supplied and never the value.

It is an identifier rather than a credential. It is an environment secret anyway,
because the environment is where every other account-specific value already lives and
because a repository variable would have to be created either way.

## What is checked offline, and how it could have been vacuous

`test/release/scenario39.check.ts` grew two describes. The first reads the workflow:
dispatch-only, `environment: rehearsal`, the role secret, the pins, the backend names,
plan-only by default, the guard before the apply, and `bash -n` over every shell block
— because a dispatch-only workflow is never run by accident, so a syntax error in it
would be found on the one run that costs something.

All of that is text, and text assertions pass against a guard that approves
everything. So the second describe **runs the guard**: one plan it must accept and
five it must refuse (a destroy, a replacement, an unexpected type, a production name,
a resource it cannot name, and a plan file that is not there). The release workflow's
credential-free `dry-run` job runs the same six on every pull request, and
`scripts/releaseMutationCheck.mjs` gains two mutations — remove `environment:
rehearsal`, and stop refusing a destroy — each of which must turn the suite red.

The last piece of drift this could suffer is a workflow that acquires a step nobody
read. The guard's `commands` mode prints the exact command list, the release dry run
prints it on every pull request, and the check requires **every printed line to appear
in the workflow that runs it**, so the printed plan cannot become a description of a
workflow that no longer exists.

## What this could not verify

Nothing here has been run. In particular:

* whether `fss-rh-deploy` may read and write
  `fss/greenfield/rehearsal-registry/terraform.tfstate`. Its policy was written for
  ephemeral run resources, and a state-bucket grant scoped to
  `fss/greenfield/rehearsal/*` — the per-run space — would exclude this key by
  construction, because G12c deliberately put it outside that space. If `init` is
  refused, that is the cause; `infra-apply-runbook.md` 2.1 names the exact ARNs to
  check.
* whether `fss-rh-deploy` may `ecr:CreateRepository` on `fss-rh-api` (G12c's open
  question, unchanged).
* whether the `rehearsal` environment has a required reviewer. If it does, both runs
  wait for an approval, which is a feature here rather than a problem.
