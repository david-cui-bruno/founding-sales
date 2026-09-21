# Mock providers keep computed values unknown, and a claim about one belongs in an apply run

Lane G12j, 21 September 2026. Status: decided and implemented.

## The setting, confirmed from the binary

Every `mock_provider` in `infra` set `override_during = plan`. Terraform's own diagnostic
says what that means, and the wording is the reason this record exists. Running a plan
assertion over a mocked computed attribute with `override_during = apply` gives:

```
Error: Unknown condition value
...
Condition expression could not be evaluated at this time. This means you have executed a
`run` block with `command = plan` and one of the values your condition depended on is not
known until after the plan has been applied. Either remove this value from your condition,
or execute an `apply` command from this `run` block. Alternatively, if there is an override
for this value, you can make it available during the plan phase by setting
`override_during = plan` in the `override_` block.
```

So `plan` makes mocked computed attributes **known while planning**, which no provider
ever does, and `apply` keeps them **unknown until the apply phase**, which is what a real
plan sees. Checked against the installed Terraform 1.15.8 on a scratch module rather than
recalled: with `override_during = apply`, `count = var.arn == null ? 1 : 0` on an ARN
taken from another mocked resource fails with exactly the rehearsal's *"Invalid count
argument … cannot be determined until apply"*, and with `plan` it passes. The same
scratch check confirmed that a `validation` block whose condition depends on an unknown is
deferred rather than failed, and that `override_resource` behaves like the provider mock:
its values arrive during the apply phase unless told otherwise.

## Decision

1. **`override_during = apply` everywhere, with one exception.** All seventeen test files
   in `infra` that mock a provider now keep computed values unknown through the plan, so
   a `count`, a `for_each` or a conditional that depends on one fails offline the way it
   failed in CI.

2. **The exception is the Google mock in `infra/roots/production/tests/isolation.tftest.hcl`,
   and it is stated in a comment there.** Those runs assert that the Pub/Sub topic id and
   the push service account this root creates reach both task definitions — values a real
   plan does not know. With `apply` the assertions could not be evaluated at all, and the
   thing they check (a string making three hops through a module boundary) is worth more
   than the thing they would then miss: the `count` on `module.pubsub` keys off a plain
   boolean variable, so the unknown-at-plan class cannot hide behind it.

3. **A claim about a value only the apply knows is made in an apply run.** Eight files
   gained one, always as the last run in the file so that no plan run inherits its state:

   | Module | What the apply run proves |
   |---|---|
   | `alerts` | the topic ARN every alarm and the composite notify (two claims, in `thresholds`) |
   | `cluster` | each one-off task definition carries the identity it is for, and the three are three |
   | `database` | the storage key is the module's own customer key, not the AWS-managed one |
   | `edge` | access logs land in the module's own bucket |
   | `journal` | the rendered bucket policy: the deny, the two writers, the reader, the TLS deny |
   | `observability` | every log group is encrypted with the module's own key |
   | `pubsub` | the push token is minted for the dedicated service account |
   | `secrets` | every entry is encrypted with the module's own key |
   | `updates` | only this distribution may read the package bucket |

   A mocked apply is still offline: `mock_provider` replaces the provider, so nothing is
   configured, no credential is read and no call is made. What it does is let Terraform
   resolve the attributes the mock declares, which is the only way to compare two of them.

4. **Where an apply run would have passed vacuously, it was made able to fail.**
   `infra/modules/cluster`'s mock gives every `aws_iam_role` the same ARN, so
   `task_definition.task_role_arn == aws_iam_role.migration_task.arn` was true whichever
   role the definition referenced — under the old `plan` overrides as much as under an
   apply. Four `override_resource` blocks now give those roles distinct ARNs and the run
   also asserts the three one-off definitions hold three different identities.

5. **One provider validation only an apply reaches.** `aws_lb_listener` checks that its
   default action names something ARN-shaped, and a mocked apply generates a short
   placeholder for any attribute with no declared default: `"default_action.0.target_group_arn"
   (s8v0vr7p) is an invalid ARN`. `infra/modules/edge`'s mock now declares an ARN for
   `aws_lb_target_group`. Worth knowing generally: an apply run exercises schema
   validation a plan run over the same module never reaches.

## What is still invisible offline, and what to do about it

`mock_provider` replaces the provider configuration. No test in this repository can
therefore observe a missing credential, a wrong region, an `allowed_account_ids`
mismatch or an `assume_role` that fails — the whole class the *first* of the third
rehearsal's two errors belongs to. The answer is not a cleverer mock; it is
`docs/greenfield/infra-apply-runbook.md` 3.0: a local production plan is the first
credentialed action after any Terraform change, before any rehearsal.
