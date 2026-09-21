# What a rehearsal proves, what it only asserts, and the three things this lane could not close

**Lane:** G12 · **Spec:** 16.2, Appendix G 11, 20, 22, 39, 42

Five scenarios are marked rehearsal-only. It is worth being precise about what each one
will actually have demonstrated when the workflow goes green, because "the rehearsal
passed" is going to be load-bearing in a decision David makes about sending real email.

## 11 — restore

**Proved.** A point-in-time restore really happened; the journal replay really
reinserted events and really inserted nothing the second time; the Sent search really
found messages; no send repeated; coverage was proved for every mailbox; the generation
advance released the restore holds and nothing else.

**Only asserted.** That the drill is representative of a production failure. It is a
rehearsal environment with a rehearsal mailbox and a small amount of fixture traffic,
and the CRM recovery point objective it measures is a number from that traffic rather
than from Callie's.

**The vacuous pass, closed.** A drill against an empty database reconstructs nothing and
passes in four minutes. `rehearsal-restore-drill.sh` refuses to report a pass when the
baseline lacks any of Appendix G 11's five kinds, and `scenario11.check.ts` runs the
script offline with an empty baseline and requires the refusal — which is how the
mutation check kills a deleted guard rather than a deleted comment.

## 20 — the old stack

**Proved.** The export refuses a source table holding a write after the watermark, with
the real reader rather than a fixture one.

**Only asserted.** That the old stack is read-only. That is an operational act — a
policy change on the old table — and no test in this repository can make it true. What
*is* checked structurally is that FSS contains no writer at all: no `PutItem`,
`UpdateItem`, `DeleteItem` or `BatchWriteItem` anywhere in the carry tooling or the
worker, so "roll back to the old stack" is not a command that exists.

## 22 — schema ranges

**Proved.** The declared deploy order works: migrate, then worker, then API. A task
definition declaring a range one below an image's minimum is refused at startup.

**Not proved, and this is the interesting one.** "The previous image against the new
schema" has no compatible pair at migration 0014: every declared range is strict
`{14, 14}`. So the scenario asserts the refusal — `database_ahead_of_binary` for the
previous release's range against schema 14 — and says why. The check computes the
overlap from the constants rather than assuming one, so a future expand release that
*does* widen a range a release ahead of its migration will take the other branch
automatically.

## 39 — environment isolation

**Proved offline.** The two roots' plans use distinct state keys, roles, secrets and
name prefixes, under mocked providers, with each root refusing the other's prefix.

**Proved in rehearsal.** After teardown, the rehearsal state contained nothing named
`fss-prod`, the identity that ran it was an `fss-rh-` role, and the production resource
inventory is byte-identical before and after.

**Refuted, 21 September 2026.** "Proved in rehearsal" above was written before any
rehearsal had run. The first one refused its own production-inventory read and created
nothing, so none of that paragraph has happened yet. See
`docs/decisions/g12f-the-rehearsals-own-guard-refused-the-rehearsal.md` and
`docs/greenfield/release.md` 8.0 for what the run did prove (OIDC, the assumed-role
session, `if: always()`, and no release record) and what it refuted.

**Only asserted.** The IAM boundary itself. `fss-rh-deploy`'s condition on `fss-rh-*` is
what makes the last clause true, and a workflow run cannot prove a permission it never
attempts to use. `rehearsal-common.sh` refuses any argument naming the production prefix
before the call is made, so a mistake surfaces as a script error rather than as an
`AccessDenied` in a log nobody reads — but the boundary is David's, in IAM, and section
1.1 of the apply runbook is where it is checked.

## 42 — the sending gate

**Proved.** Each of the four conditions independently holds sending off; all four
together turn it on. The release record refuses a failed suite, a tag in place of a
digest, one image under both names, and a run whose drills left no report.

**Only asserted.** That the digests in the record are the digests deployed to
production. That comparison is deliberately David's, at enable time, against what
production is actually running — it is the moment a person takes responsibility for the
claim that the thing rehearsed is the thing deployed, and automating it would move the
responsibility without moving the risk.

---

# Three things this lane could not close

These are reported rather than fixed, because each needs a change to `infra/modules`,
which the release lane may not make.

**1. The worker cannot write the suppression journal.** `infra/modules/cluster`'s
worker task role has `s3:GetObject`/`ListBucket` on the journal and `kms:Decrypt` on the
journal key — "replay the journal after restore" — and no `s3:PutObject` and no
`kms:GenerateDataKey`. But the worker's mail pipeline records prospect opt-outs during
sync, and 10.2 requires the journal write *before* acknowledgement. A credentialed
worker will be refused by IAM on the first opt-out it imports. This must be fixed before
Gmail sync is enabled in production.

**2. The Pub/Sub topic and the hosted domain are not in the task environment.**
`gmail_push_topic_id` is only a Terraform output; the Workspace domain is nowhere. The
bootstrap reads both from the operator-written `google-gmail-oauth-client` secret
instead (`docs/decisions/g12-the-credentialed-bootstrap.md`), which needs no
infrastructure change and is documented in `docs/greenfield/release.md` 1.6. The tidier
fix is two lines in `infra/modules/stack/main.tf`'s `environment` map, and it would also
need the production root to surface `extra_environment`.

**3. `@aws-sdk/client-kms` was imported and declared nowhere.** `loadKmsTransport` has
dynamically imported it since G7 and no `package.json` listed it, so `npm ci --omit=dev`
would not have put it in either image and the first envelope operation in production
would have failed with `ERR_MODULE_NOT_FOUND`. This lane declared it on
`packages/domain` (and `@aws-sdk/client-s3` on `apps/api`, for the journal put). It is
listed here because it was a latent production failure rather than a new dependency.
