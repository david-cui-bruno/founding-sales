# Rehearsal registry Terraform state. Public identifiers only; never a credential.
#
# The bucket and lock table predate this root and are inputs, exactly as in the
# other two roots.
#
# The key is deliberately NOT under fss/greenfield/rehearsal/, which is where a
# run's state lives as fss/greenfield/rehearsal/<run>/terraform.tfstate. A run
# suffix of "registry" is a legal rehearsal prefix, and a run whose state key
# collided with this one would destroy the two durable repositories on teardown.
# infra/scripts/offline-gate.sh asserts all three keys differ and that this one
# is outside the per-run space.
#
# The state KMS key ARN is account-specific and is supplied at init time:
#   terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<arn>"

bucket         = "callie-sourcing-tfstate-326255650484"
key            = "fss/greenfield/rehearsal-registry/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "callie-sourcing-tflock"
encrypt        = true
use_lockfile   = true
