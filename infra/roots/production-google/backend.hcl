# Production Google Terraform state. Public identifiers only; never a credential.
#
# The same bucket and lock table as `infra/roots/production`, under a key of its own.
# This root owns the four Gmail push objects in Google Cloud and nothing else; the
# production root no longer names them (lane g85,
# `docs/decisions/g85-the-google-provider-has-its-own-root.md`). Nothing here creates,
# modifies or grants access to the bucket or the table.
#
# The key names the root, like `fss/greenfield/rehearsal-registry/`: it is outside
# `fss/greenfield/production/` so that the two production state objects are two
# objects with two locks, and outside `fss/greenfield/rehearsal*`, the only key space
# `fss-rh-deploy` may read or write, so no rehearsal can reach it.
#
# This root has no AWS provider. The backend reads and writes the state with whatever
# AWS credential the shell holds, which for a production state is the admin profile,
# exactly as for `infra/roots/production`: `fss-prod-deploy` is denied `s3:GetObject*`
# on every object by `NoDeploymentDataAccess` in its own policy and never touches state.
#
# ## This file is the per-account file, and it is the only one
#
# Nothing under `infra/**/*.tf` names a bucket, a lock table or an account id. When the
# production state moves to a dedicated AWS account (`docs/greenfield/accounts.md`)
# exactly three values below change, the same three as in
# `infra/roots/production/backend.hcl`:
#
#   bucket          that account's Terraform state bucket
#   region          the region that bucket is in
#   dynamodb_table  that account's lock table
#
# The key does not. The Google project does not move with the AWS account either.
#
# The state KMS key ARN is the production state key, supplied at init time:
#   terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<arn>"
#
# Never point this root at `fss/greenfield/production/terraform.tfstate`, at a legacy
# sourcing key, or at anything under `fss/greenfield/rehearsal`.

bucket         = "callie-sourcing-tfstate-326255650484"
key            = "fss/greenfield/production-google/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "callie-sourcing-tflock"
encrypt        = true
use_lockfile   = true
