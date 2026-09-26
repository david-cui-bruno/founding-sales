# The three deployment flags are root variables, and rehearsal deploys `live`

**Lane:** G12c · **Spec:** 16.2, Appendix G 42 · **Files:** `infra/modules/stack/{main,variables}.tf`, `infra/roots/{production,rehearsal}/{main,variables}.tf` and their `tests/isolation.tftest.hcl`

## What was wrong

`apps/api/src/bootstrap/deployment.ts` and `apps/worker/src/bootstrap/deployment.ts`
read three environment variables and refuse rather than default on each:

| Variable | Absent means |
|---|---|
| `FSS_DEPENDENCIES` | in production, `DEPENDENCIES_UNSET` and the process exits |
| `FSS_SENDING_ENABLED` | `false`; a typo that is neither `true` nor `false` is a refusal |
| `FSS_RESEARCH_PROVIDERS` | the worker ships no live research adapter |

`infra/modules/stack` could carry them, through `extra_environment`. Neither root
exposed `extra_environment`, so there was no value an operator could pass to either
root that put any of the three in a task definition. `docs/greenfield/release.md` 4
told David to set `FSS_DEPENDENCIES` "in `extra_environment` or the plan review";
neither of those was a thing that existed. The first production apply would have
produced two services whose tasks exit at startup naming a variable no plan could set.

## The decision

Three **first-class** variables on the stack module and on both roots, plus
`extra_environment` surfaced at both roots for whatever comes next:

| Root variable | Type | Production default | Rehearsal default | Lands as |
|---|---|---|---|---|
| `dependencies_mode` | string, `live\|recorded` | `live` | `live` | `FSS_DEPENDENCIES`, both tasks |
| `research_providers` | string | `none` | `none` | `FSS_RESEARCH_PROVIDERS`, **worker only** |
| `sending_enabled` | bool | `false` | `false` | `FSS_SENDING_ENABLED`, both tasks |
| `extra_environment` | map(string) | `{}` | `{}` | both tasks |

First-class rather than three entries in a map, because each is a value a process
refuses to guess at, and a map entry is exactly as easy to misspell as to omit. A
misspelled key in `extra_environment` produces a task that exits at startup; a
misspelled variable name produces a plan that refuses.

**`none` is not offered.** The bootstraps accept `live`, `recorded` and `none`, and
`none` is the shape this repository shipped before G12: no Gmail, no classifier, no
research, three job kinds waiting unclaimed. That is a laptop value. Both binaries
already refuse it when `FSS_ENVIRONMENT` is production, and the validation here means
an operator learns it from a plan instead of from a crash loop. The rehearsal root
refuses it too, for the same reason and one more: a rehearsal that proved nothing about
the production dependency path would still write a release record.

**`recorded` is accepted in production by the plan and refused at run time.** The
validation is `live|recorded` in both roots rather than `live` in production, because
duplicating `PRODUCTION_REQUIRES_LIVE` in Terraform would put the same rule in two
places that can disagree, and the binaries' refusal is the one that cannot be bypassed
by editing a variable. A production task definition carrying `recorded` starts, reads
its own `FSS_ENVIRONMENT`, and exits naming the conflict.

## Why the rehearsal default is `live`, not `recorded`

An earlier reading had the rehearsal default to `recorded`, on the reasoning that a
rehearsal has no real mailbox. That is true of Gmail and false of everything else.

G12b made Google sign-in a start-up requirement of a live API
(`docs/archive/decisions/g12b-sign-in-is-configured-or-the-api-refuses.md`), and the rehearsal
signs in with the **real** OIDC client under its second registered redirect URI,
`https://api.rehearsal.usecallie.com/auth/google/callback`. A `recorded` rehearsal
would not exercise the code path production runs, and 16.2's "the rehearsal environment
deploys the exact immutable artifacts intended for production" would be true of the
bytes and false of the configuration around them.

The single step that genuinely needs the fake — the suppression journal replay and the
Sent reconstruction, where no rehearsal mailbox exists — already sets
`FSS_DEPENDENCIES: recorded` on its own workflow step. That is the fake being chosen by
name, which is what `deployment.ts`'s comment asks for: *"A rehearsal that reached the
fakes by omission would be a rehearsal that proved nothing about the production path."*

A run against a rehearsal-only Google project can still apply with `recorded`;
`a_rehearsal_may_choose_the_recorded_dependencies_by_name` asserts that it works, so
the default is a default rather than a hard-coding.

## What the tests assert

Against the planned container environment, never against the variables:

* both containers carry `FSS_DEPENDENCIES` and `FSS_SENDING_ENABLED`;
* only the worker carries `FSS_RESEARCH_PROVIDERS` — asserted as an absence on the API,
  because a variable a process never reads is a variable that drifts;
* `sending_enabled = true` really does reach both containers, so the default assertion
  is not a test that always passes;
* an `extra_environment` entry reaches both containers;
* `dependencies_mode = "none"` is refused by both roots.
