# Production Terraform state. Public identifiers only; never a credential.
#
# The bucket and lock table predate this root. cloud/scripts/bootstrap-terraform-state.sh
# created them once for the shared account; this root does not provision,
# modify or grant access to them.
#
# Explicit SSE-S3/AES256 for state AND native locks: encrypt=true, no kms_key_id.
# Use only -backend-config=backend.hcl. A KMS change requires a separately reviewed
# exact key/caller contract, not an optional init flag. This is not live approval.
#
# Never point this root at the legacy sourcing key cloud/terraform.tfstate or
# at the delegated-worker key cloud/delegated-worker/terraform.tfstate.

bucket         = "callie-sourcing-tfstate-326255650484"
key            = "fss/greenfield/production/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "callie-sourcing-tflock"
encrypt        = true
use_lockfile   = true
