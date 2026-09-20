# Rehearsal Terraform state. Public identifiers only; never a credential.
#
# The key below is the single-run fallback. CI overrides it per run with
#   -backend-config="key=fss/greenfield/rehearsal/${RUN_ID}/terraform.tfstate"
# so two concurrent rehearsals never share a state object or a lock.
#
# This key is under fss/greenfield/rehearsal/ and can never be the production
# key fss/greenfield/production/terraform.tfstate. The CI workflow asserts it.
#
# The state KMS key ARN is account-specific and is supplied at init time:
#   terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<arn>"

bucket         = "callie-sourcing-tfstate-326255650484"
key            = "fss/greenfield/rehearsal/default/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "callie-sourcing-tflock"
encrypt        = true
use_lockfile   = true
