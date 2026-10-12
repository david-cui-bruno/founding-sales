# Held bootstrap preparation — October 12, 2026

This is a read-only readiness packet, not a fresh saved Terraform plan or application approval. Source is pinned to main `35cb69977624d31b95b61b39b41d03f342af474c`, schema105. The shared checkout was rechecked and matches that commit; this packet hashes named source files from that exact commit.

At20:48Z production remained `d49dda37dfb6d95cb7c5aa077da2f32b2724dc79`, schema88, healthy/stable API2 and worker1. Immutable deployed images were present. Direct read of the existing production S3 state observed lineage `3da78742-0d5e-99d0-59be-19e4e725dd49`, serial114, Terraform1.15.8; retained private state SHA256 is `443aad22b2263469829ec505dd40d6925d1bf00a72a8745658e1f2c9473016ae`. Mailbox controls were not inspected or changed. Fresh RDS metadata reported available,35-day retention and latest restorable time20:43:14Z; restore itself remains untested.

Repository and production-deploy environment release-hold variables are both absent: the literal-false guard remains held. No new planner/maintenance/review environments exist. The planner and maintenance IAM roles remain absent; the existing deploy role exists. Main deployment38306493500 was still running only the image/gate decision job, not a deployment writer. Candidate image workflow38305864908 completed successfully; main gate38305864844 was still running. Google production runs were completed, with no observed active Google writer.

A full writer freeze was **not established**: this inspection cannot attest exclusion of manual production writers. The ambient AWS identity is an IAM user. That does not itself prove the identity untrusted; its designation as the already-trusted bootstrap administrator is not established by this inspection. The exact runbook requirement is: “Bootstrap uses the already-existing trusted administrator deployment identity and existing production Terraform root, as a specifically reviewed exception outside the GitHub queue.” No role was assumed or credential reused. Consequently no Terraform plan/init, backend lock, state write or cloud application occurred. This follows the one-time prerequisite in [lean releases](../operations/lean-release-workflow.md): “first freeze all production writers”.

The available binary `/Users/davidcui824/.local/bin/terraform` reports1.15.8, darwin_arm64, SHA256 `ec83c7c64d8eb67b2d7c37935d6bcbe93b4ec3533b1ee223a8fb07daa098f9e8`. The requested `/Users/davidcui824/.local/bin/terraform1.15.8` path is absent. No alias or replacement was created. The observed binary is the correct1.15.8 runtime; its actual path/hash are recorded rather than treating a different filename as an access failure.

## Narrow actions and privilege interpretation

The historical unapplied plan checksum remains `b9d35c35a39df1e0297d0331550203d93d0d718804a4929ecb15836b6524045a`, frozen historical source `6e13be207319882e9737b9cbcbbb83b7d4dd642b`. Its state serial matching today is insufficient to call it fresh or approved. Expected narrow actions are:

- Create `aws_iam_role.ci_plan` and `aws_iam_role_policy.ci_plan`: read-only production preparation with narrowly scoped existing-backend lock writes, without application or secret-value reads.
- Create `aws_iam_role.ci_maintenance` and `aws_iam_role_policy.ci_maintenance`: reviewed existing-resource stop/migrate/start authority, without Terraform-state or IAM writes.
- Update `module.stack.module.journal.aws_s3_bucket_policy.journal`: planner listing-only exemption, preserving journal retention and write controls.

The separate additive reviewed deployment OIDC trust must preserve the actual existing statements. Current candidate proposal SHA256 is `4e47d06986045d121a5afee6fa51463600622f091e2bac11159e6ebd7f45dbd9`; historical proposal checksum differs. Live existing trust is retained privately, but this packet does not claim fresh reconciliation or approve replacement. Reject any future plan containing service/task/image changes, RDS/backlog/schema changes or other addresses.

## Missing prerequisites and recovery

Establish the complete writer freeze and trusted bootstrap identity, finish candidate main gate/image manifest binding, then create a fresh narrow saved plan under the pinned Terraform binary and inspect its exact action/checksum/state/source bindings. Only then request concrete application approval, plus separate GitHub environment/role-secret/key configuration approval. Bootstrap does not authorize held-backlog deployment or capability Enable.

If bindings change, prepare again; do not silently regenerate an approved plan. If an eventual apply is ambiguous or partial, observe actual IAM/state before forward repair rather than blindly retry. Keep the release hold until actual IAM readback and readiness are verified. No freeze removal is performed by this packet.

Private evidence and values-free manifest are in `.context/held-bootstrap-preparation-20261012/` with directory0700/files0600. Manifest SHA256: `d6ca6db26c98a0b5acaac1f9f82c7bd1f6e1f098e5f029b5699d35748695ef86`. No cloud writes, backend locks, state changes, deployment, activation, provider calls or sending changes occurred.
