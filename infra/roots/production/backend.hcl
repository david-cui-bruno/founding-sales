# Production Terraform state. Public identifiers only; never a credential.
#
# The bucket and lock table predate this root. cloud/scripts/bootstrap-terraform-state.sh
# created them once for the shared account; this root does not provision,
# modify or grant access to them.
#
# ## This file is the per-account file, and it is the only one
#
# Nothing under `infra/**/*.tf` names a bucket, a lock table or an account id: the
# roots take `aws_account_id` and `aws_region` as variables, and the backend is
# bound at `terraform init -backend-config=backend.hcl`. So when this root moves to
# a dedicated AWS account (`docs/greenfield/accounts.md`) exactly three values below
# change and nothing else in the tree does:
#
#   bucket          that account's Terraform state bucket
#   region          the region that bucket is in
#   dynamodb_table  that account's lock table
#
# The key does not: a state key names a root and a run, and it means the same thing
# in every account. Neither does `aws_account_id`, which reaches the root as
# `TF_VAR_aws_account_id` or `-var` and is never read from this file.
#
# Any value here can also be overridden at init without editing the file, because a
# later `-backend-config` wins:
#
#   terraform init -backend-config=backend.hcl -backend-config="bucket=<other>"
#
# The state KMS key ARN is account-specific and is supplied at init time:
#   terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<arn>"
#
# Never point this root at the legacy sourcing key cloud/terraform.tfstate or
# at the delegated-worker key cloud/delegated-worker/terraform.tfstate.

bucket         = "callie-sourcing-tfstate-326255650484"
key            = "fss/greenfield/production/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "callie-sourcing-tflock"
encrypt        = true
use_lockfile   = true
