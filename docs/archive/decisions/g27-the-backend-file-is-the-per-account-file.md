# G27: each root's `backend.hcl` is its account's file, and the account is never in Terraform

**Decided:** 22 September 2026, G27, under spec silence.
**Context:** David's decision to move the rehearsal and production into dedicated AWS
accounts under Organizations before the first production release
(`docs/greenfield/accounts.md`).

## The question

A Terraform `backend "s3"` block cannot take a variable, so the bucket, the region and
the lock table have to arrive from somewhere outside the configuration. Two shapes were
available:

1. **A shared per-account file.** Strip `bucket`, `region` and `dynamodb_table` out of
   each root's `backend.hcl`, leaving only the state key, and add
   `infra/accounts/<alias>.s3.tfbackend` holding the three account values. Every `init`
   then passes two `-backend-config` files, and one account file serves all three roots.
2. **Each root's own `backend.hcl` is the per-account file.** Change nothing about the
   command; document the file as the thing that binds the root to an account, and say
   which three values change when it moves.

## The decision: (2)

**Each root belongs to exactly one account.** `infra/roots/rehearsal` and
`infra/roots/rehearsal-registry` run only in the rehearsal account;
`infra/roots/production` runs only in the production account. There is nothing to
multiplex, so the sharing that shape (1) buys is sharing between files that will never
hold different values at the same time — and it buys it at the cost of a second
`-backend-config` on every `init` in the runbook, the release document, three workflows
and the release suite, on the week of a cutover.

`backend.hcl` is already **not code**: it is a `-backend-config` argument file, the
roots declare `backend "s3" {}` with no arguments at all, and a later `-backend-config`
overrides any value in it. So the brief's "no hard-coded bucket in code if avoidable"
is met by construction, and its fallback — "if the backend block must be literal, make
it a documented per-account file" — is exactly what shape (2) is. What was missing was
the documentation and the enforcement, and those are what this lane added:

- each `backend.hcl` opens with what it is, which three values change and which do not;
- `infra/scripts/offline-gate.sh` and `.github/workflows/greenfield-infra.yml` refuse a
  backend file missing a bucket, a region, a lock table or a key, because a file that
  lost one would `init` against whatever backend the caller's own configuration
  supplies and say nothing;
- `test/release/accountAgnostic.check.ts` refuses an account id in any `.tf` file
  outside a variable default, and in any workflow or script outside a default
  assignment;
- `vars.FSS_REHEARSAL_STATE_BUCKET`, when the repository sets it, is checked against
  the file, so an account that moved while the file did not is a red run rather than a
  state object written into the old account.

## The account itself is never in a backend file

`aws_account_id` is a root variable with the shared account as its default and a
twelve-digit validation. The two rehearsal workflows do not read it from anywhere in
the repository: they take it from `aws sts get-caller-identity` after the step that
proves the session is an assumed-role session of `fss-rh-deploy`, and export
`TF_VAR_aws_account_id`. The account an apply runs in is therefore always the account
the credential belongs to, and `vars.FSS_REHEARSAL_ACCOUNT_ID` is a second statement of
the same fact that the run refuses to proceed without agreeing with.

That is the same principle the release and rehearsal scripts already followed —
`release_caller_account`, `REHEARSAL_SESSION_ACCOUNT`, and the journal bucket named
`<prefix>-suppression-journal-<account>` from the verified session (G17). This lane
made the workflows and the roots follow it too.

## What it costs

If a root ever did have to run in two accounts at once, shape (2) would need a second
file per root rather than a second alias. Nothing in the design wants that, and the one
case that looks like it — a rehearsal in the shared account and a rehearsal in the new
one, during the move — is served by the `-backend-config` override that every
`backend.hcl` now documents.
