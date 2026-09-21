# The alert topic key is a boolean the caller states, not a null check on an ARN

Lane G12j, 21 September 2026. Status: decided and implemented.

## What happened

David's third credentialed rehearsal (Actions run 35611374218, commit 845c6ed5) stopped
in `terraform plan`, before any AWS call, with two independent errors. The second was:

```
Error: Invalid count argument
  on ../../modules/alerts/main.tf line 262, in resource "aws_kms_key" "alerts":
 262:   count = var.kms_key_arn == null ? 1 : 0
The "count" value depends on resource attributes that cannot be determined until apply.
```

`infra/modules/stack` passes `module.observability.kms_key_arn` — a key created in the
same apply. While Terraform plans, that value is unknown, and Terraform will not even
claim it is non-null, so `var.kms_key_arn == null` is unknown and a `count` may not
depend on an unknown.

Nothing offline could see it. `terraform validate` never evaluates a `count`. The
module's own tests passed a *literal* ARN, and a literal is never unknown. And both
test files set `override_during = plan` in their `mock_provider`, which makes mocked
computed attributes known during the plan — the opposite of what a provider does.

## Decision

1. **A boolean input, `create_kms_key` (default `true`), decides it.** The value is known
   before the graph is walked, so the two `count` expressions are known too.
   `kms_key_arn` stays, and is now read in exactly one place —
   `local.topic_key_arn = var.create_kms_key ? aws_kms_key.alerts[0].arn : var.kms_key_arn`
   — where an unknown is ordinary. `infra/modules/stack` passes the literal `false`
   beside the observability key, which is also where David's "logs and alerts share one
   key" decision of 20 September is now stated rather than inferred.

2. **The invalid combination is guarded by a `validation` block on `create_kms_key`,
   not by a precondition.** `condition = var.create_kms_key || var.kms_key_arn != null`.
   The mechanism matters, so here is what each does with an ARN that is unknown at plan
   time, confirmed against the installed Terraform 1.15.8 rather than from memory:

   - **Variable validation** (chosen). A literal `null` is known, so the invalid
     combination is refused *during the plan* and the diagnostic names the variable the
     caller typed. When the ARN is a value the same apply computes, the condition is
     unknown, and Terraform defers the check to the apply, where the ARN is a string.
     Either way there is no path to an alert topic with no customer key. Cross-variable
     references in `validation` need Terraform >= 1.9, which this module already
     requires.
   - **A `lifecycle` precondition on the topic** would behave the same way on the
     unknown case but would report the failure against a resource address rather than
     against the input, three modules away from the person who typed it.
   - **A `count` or a conditional expression** is the thing that broke, and any
     expression that branches on the ARN's *value* re-introduces it.

3. **The module says which of the two it did.** `output "created_own_kms_key"` is
   `length(aws_kms_key.alerts) == 1`, a boolean every plan knows, so a caller and a test
   can assert the decision without touching an ARN. It is what
   `tests/key_from_the_same_apply.tftest.hcl` asserts.

4. **The grep is part of the gate.** `infra/scripts/offline-gate.sh` refuses any
   `count` or `for_each` that compares a `var`/`local`/`module`/`data` reference with
   `null`. This class of error is invisible to `validate`, to `terraform test` with
   plan-time overrides, and to the dry-run script scan; the only tools that find it are
   a real plan and this one line.

## What this does not change

No resource. The key the production stack will create is still the observability key and
the alert topic is still encrypted with it; `moved` blocks are not involved, because
nothing has ever been applied from this module. The two `count` addresses
(`aws_kms_key.alerts[0]`, `aws_kms_alias.alerts[0]`) are unchanged for a caller that
creates its own key, which is the module's default and what its threshold tests use.
