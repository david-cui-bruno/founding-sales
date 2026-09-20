# Production Terraform state. Public identifiers only; never a credential.
#
# The bucket and lock table predate this root. cloud/scripts/bootstrap-terraform-state.sh
# created them once for the shared account; this root does not provision,
# modify or grant access to them.
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
