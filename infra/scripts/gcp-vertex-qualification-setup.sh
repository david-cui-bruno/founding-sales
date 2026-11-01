#!/usr/bin/env bash
# One-time GCP setup for prepared-prospect qualification on Vertex AI (David, 1 November 2026).
#
#   infra/scripts/gcp-vertex-qualification-setup.sh [--dry-run]
#
# Creates, in GCP project colormyworld-prod-dc824 (billing account "Framewise Health Main"):
#   1. a workload identity pool and an AWS provider for AWS account 326255650484 whose
#      attribute condition admits ONLY the production worker task role
#      arn:aws:sts::326255650484:assumed-role/fss-prod-worker-task/*;
#   2. the service account callie-qualification@colormyworld-prod-dc824.iam.gserviceaccount.com
#      with roles/aiplatform.user on the project and no other role;
#   3. roles/iam.workloadIdentityUser on that service account for exactly that role's principalSet.
# No key is created. The worker exchanges its ECS task-role credentials for a short-lived token
# (apps/worker/src/sourcing/vertexCredentials.ts). The worker's non-secret credential
# configuration is built by Terraform (infra/modules/stack, FSS_VERTEX_CREDENTIAL_CONFIG) from the
# same names, held equal by test/ops/terraformCrossChecks.check.ts; this script prints the same
# document from gcloud at the end so it can be compared by eye.
#
# Idempotent: every step describes first and creates only what is missing; the IAM bindings are
# add-only and re-adding one is a no-op. Nothing here deletes or edits an existing object.
# --dry-run prints every gcloud command and runs none.
#
# The account running this needs, on the project: roles/iam.workloadIdentityPoolAdmin,
# roles/iam.serviceAccountAdmin and roles/resourcemanager.projectIamAdmin (or Owner), and
# roles/serviceusage.serviceUsageAdmin if an API below is not yet enabled. The Vertex-only account
# configured for application-default credentials on the review machine does not have them.
#
# Prints names and IAM roles only; there is no secret to print.
set -euo pipefail

PROJECT_ID='colormyworld-prod-dc824'
PROJECT_NUMBER='873586425850'
AWS_ACCOUNT_ID='326255650484'
AWS_WORKER_ROLE='fss-prod-worker-task'
POOL_ID='fss-prod-aws'
PROVIDER_ID='fss-prod-worker'
SERVICE_ACCOUNT_NAME='callie-qualification'
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
AWS_ROLE_ARN="arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${AWS_WORKER_ROLE}"
POOL_PATH="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
PRINCIPAL_SET="principalSet://iam.googleapis.com/${POOL_PATH}/attribute.aws_role/${AWS_ROLE_ARN}"

DRY_RUN=0
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

say() { printf '%s\n' "$*"; }

# Run a gcloud command, or print it (shell-quoted, so it can be pasted) under --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'DRY-RUN gcloud'; printf ' %q' "$@"; printf '\n'
  else
    printf '+ gcloud'; printf ' %q' "$@"; printf '\n'
    gcloud "$@"
  fi
}

# True when a describe-style command succeeds. Under --dry-run nothing is known, so nothing exists.
exists() {
  [ "$DRY_RUN" = 0 ] && gcloud "$@" >/dev/null 2>&1
}

if [ "$DRY_RUN" = 0 ]; then
  command -v gcloud >/dev/null || { say 'gcloud is required' >&2; exit 1; }
  actual_number=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
  if [ "$actual_number" != "$PROJECT_NUMBER" ]; then
    say "project ${PROJECT_ID} is number ${actual_number}, not ${PROJECT_NUMBER}: refusing" >&2
    exit 1
  fi
  say "account: $(gcloud config get-value account 2>/dev/null)  project: ${PROJECT_ID} (${PROJECT_NUMBER})"
fi

say '== 1. APIs (no-op when enabled)'
run services enable aiplatform.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"

say "== 2. Workload identity pool ${POOL_ID}"
if exists iam workload-identity-pools describe "$POOL_ID" --location=global --project="$PROJECT_ID"; then
  say "pool ${POOL_ID} exists"
else
  run iam workload-identity-pools create "$POOL_ID" --location=global --project="$PROJECT_ID" \
    --display-name='FSS production AWS workloads' \
    --description='AWS identities of the FSS production account that may call Vertex AI'
fi

say "== 3. AWS provider ${PROVIDER_ID}: account ${AWS_ACCOUNT_ID}, role ${AWS_WORKER_ROLE} only"
# google.subject is the full assumed-role ARN; attribute.aws_role is the role without the session
# name, so one binding covers every session of the task role. The condition rejects every other
# role, user and account before any binding is consulted.
ATTRIBUTE_MAPPING="google.subject=assertion.arn,attribute.account=assertion.account,attribute.aws_role=assertion.arn.extract('{account_arn}assumed-role/') + 'assumed-role/' + assertion.arn.extract('assumed-role/{role_name}/')"
ATTRIBUTE_CONDITION="assertion.arn.startsWith('${AWS_ROLE_ARN}/')"
if exists iam workload-identity-pools providers describe "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project="$PROJECT_ID"; then
  say "provider ${PROVIDER_ID} exists"
else
  run iam workload-identity-pools providers create-aws "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" \
    --location=global --project="$PROJECT_ID" --account-id="$AWS_ACCOUNT_ID" \
    --display-name='FSS production worker task role' \
    --attribute-mapping="$ATTRIBUTE_MAPPING" \
    --attribute-condition="$ATTRIBUTE_CONDITION"
fi

say "== 4. Service account ${SERVICE_ACCOUNT_EMAIL}"
if exists iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID"; then
  say "service account ${SERVICE_ACCOUNT_NAME} exists"
else
  run iam service-accounts create "$SERVICE_ACCOUNT_NAME" --project="$PROJECT_ID" \
    --display-name='Callie prepared-prospect qualification' \
    --description='Calls Gemini on Vertex AI for qualification; reached only by the FSS production worker task role through workload identity federation. No key.'
fi

say '== 5. roles/aiplatform.user on the project, and nothing else'
run projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" --role=roles/aiplatform.user --condition=None

say "== 6. The worker task role may act as the service account (workloadIdentityUser)"
run iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" \
  --member="$PRINCIPAL_SET" --role=roles/iam.workloadIdentityUser

say '== 7. Verification (read-only)'
if [ "$DRY_RUN" = 1 ]; then
  say 'DRY-RUN: skipped'
else
  say "-- roles held by ${SERVICE_ACCOUNT_EMAIL} on the project (expect only roles/aiplatform.user):"
  gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
    --filter="bindings.members:serviceAccount:${SERVICE_ACCOUNT_EMAIL}" --format='value(bindings.role)'
  say "-- who may act as it (expect only ${PRINCIPAL_SET}):"
  gcloud iam service-accounts get-iam-policy "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" \
    --flatten='bindings[].members' --format='value(bindings.role,bindings.members)'
  say "-- provider condition (expect the role ARN prefix ${AWS_ROLE_ARN}/):"
  gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" \
    --location=global --project="$PROJECT_ID" --format='value(attributeCondition)'
fi

say '== 8. Credential configuration (non-secret; Terraform builds the same FSS_VERTEX_CREDENTIAL_CONFIG)'
if [ "$DRY_RUN" = 1 ]; then
  say "DRY-RUN gcloud iam workload-identity-pools create-cred-config ${POOL_PATH}/providers/${PROVIDER_ID} --service-account=${SERVICE_ACCOUNT_EMAIL} --aws --enable-imdsv2 --output-file=<temp>"
else
  config_file=$(mktemp)
  trap 'rm -f "$config_file"' EXIT
  gcloud iam workload-identity-pools create-cred-config "${POOL_PATH}/providers/${PROVIDER_ID}" \
    --service-account="$SERVICE_ACCOUNT_EMAIL" --aws --enable-imdsv2 --output-file="$config_file" >/dev/null
  cat "$config_file"
fi
say
say 'Next: terraform apply of infra/roots/production (worker task environment), then deploy. See docs/operations/vertex-qualification.md.'
