# G21: the carry read grant exists only when David names the old table, and is read-only

**Decided 21 September 2026, under spec silence.** Specification revision 3 says the
carry moves firms, evidence, every suppression and unapproved template bodies from the
old table under a write watermark (section 2, "Data carry"; section 17), and Appendix
G 20 says the old stack is read-only and cannot be a rollback target. It says nothing
about which principal reads the old table in a rehearsal, or what that principal may
do.

## The problem

`infra/scripts/rehearsal-carry-watermark.sh` runs in the release workflow's rehearsal
job, whose session *is* `fss-rh-deploy`, and the export half runs `fss carry export`
against the old stack's DynamoDB table. The rendered rehearsal policy allowed DynamoDB
only on the Terraform lock table, and only `GetItem`/`PutItem`/`DeleteItem` under a
`dynamodb:LeadingKeys` condition naming the state keys. Setting the two `rehearsal`
environment secrets (`FSS_REHEARSAL_CARRY_WATERMARK`, `FSS_REHEARSAL_CARRY_TABLE`)
would therefore have turned the drill on and failed it on permissions, an hour into a
rehearsal, on the week of the cutover.

## The decision

One statement, `ReadTheOldStackTableForTheCarryDrill`, rendered for `fss-rh` only and
**only when the renderer is given `FSS_POLICY_CARRY_SOURCE_TABLE`**.

```json
{
  "Sid": "ReadTheOldStackTableForTheCarryDrill",
  "Effect": "Allow",
  "Action": ["dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"],
  "Resource": [
    "arn:aws:dynamodb:us-east-1:326255650484:table/<name>",
    "arn:aws:dynamodb:us-east-1:326255650484:table/<name>/index/*"
  ]
}
```

### Why conditional rather than always present

The old table's name is not in this repository and the table is not this system's. A
policy that always carried the statement would need a placeholder name, and a
placeholder in a live IAM document is a grant on a resource nobody chose — the same
class of thing as a wildcard nobody meant. Unset, the statement does not render at
all, and the renderer fails closed if the sentinel it substitutes in the meantime ever
survives into the document.

The name is a public identifier (a DynamoDB table name), so it goes in an environment
variable at render time and not in a secret. The renderer refuses anything that is not
a plain table name — a `/` or a `:` would silently widen or misdirect the ARN — and
refuses a name beginning `fss-prod`.

### Why read-only

Appendix G 20 and section 4.2: the old stack is never a rollback target.
`rehearsal-carry-watermark.sh` already proves the *tooling* contains no writer, by
grepping `apps/worker/tools/carry` and `apps/worker/src` for `PutItemCommand`,
`UpdateItemCommand`, `DeleteItemCommand` and `BatchWriteItemCommand`. This statement is
the same claim in IAM, which is the layer that still holds if a writer is added before
anybody notices the grep going red. No `PutItem`, no `UpdateItem`, no `DeleteItem`, no
`BatchWriteItem`, no `TransactWriteItems`, no table-level write of any kind.

`dynamodb:Scan` and `dynamodb:Query` are what a full export needs; `DescribeTable` is
what tells the reader the key schema; `GetItem` is what a targeted re-read needs. The
indexes are included because a scan of a table's index is authorized on the index ARN,
not the table's.

### Why production never gets it

`RENDER_ONLY_FOR` names the Sid as `fss-rh`, so rendering `fss-prod` with the variable
set produces a document that does not mention the table at all. The production
deployment role has no business reading the old stack: the carry into production is
run by David's **operator** role from his laptop (`carry-runbook.md` step 4), not by a
deployment role, and not by CI.

## Where the scoping check cannot see it

`test/release/deploymentRolePolicy.check.ts` narrows an `Allow` by requiring every
wildcarded resource ARN to carry a namespace token (`fss-rh`, or the state key path).
The old table carries neither, so the `index/*` ARN reads as unscoped and the Sid has
an entry in `unconditional_sids` explaining it. That is the honest answer: the
heuristic is about *this* system's namespaces and the old table is outside them. The
statement is in fact narrower than most — two ARNs naming exactly one table — and the
test that proves it evaluates the four allowed actions and eight write actions against
the table ARN rather than searching the document for a string.

## The order David runs it in

Render and put the policy **before** setting the two rehearsal secrets, because the
secrets are what turn the drill on. `carry-runbook.md` 2a is the command list;
`release.md` 3.0 item 12 says the same in one sentence. A drill turned on first fails
on permissions and the release record says so, which is the correct behaviour and an
expensive way to learn the order.
