#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --create <bucket> <lock-table> <region> <kms-key-id> <recovery-receipt> | --recover <recovery-receipt>" >&2
  exit 1
}

cleanup_bucket=false
cleanup_table=false
bucket_name=""
lock_table_name=""
region=""
receipt=""

write_receipt() {
  umask 077
  printf 'bucket=%s\ntable=%s\nregion=%s\ncleanup_bucket=%s\ncleanup_table=%s\n' \
    "$bucket_name" "$lock_table_name" "$region" "$cleanup_bucket" "$cleanup_table" >"$receipt"
  chmod 0600 "$receipt"
}

cleanup_resources() {
  local failed=false
  if [[ "$cleanup_table" == true ]]; then
    if aws dynamodb delete-table --table-name "$lock_table_name" --region "$region" >/dev/null &&
      aws dynamodb wait table-not-exists --table-name "$lock_table_name" --region "$region"; then
      cleanup_table=false
    else
      failed=true
    fi
  fi
  if [[ "$cleanup_bucket" == true ]]; then
    if aws s3api delete-bucket --bucket "$bucket_name" --region "$region" >/dev/null; then
      cleanup_bucket=false
    else
      failed=true
    fi
  fi
  write_receipt
  [[ "$failed" == false ]]
}

cleanup_on_failure() {
  trap - ERR INT TERM
  cleanup_resources || true
  echo "bootstrap failed; inspect the recovery receipt and run --recover before retrying" >&2
  exit 1
}

recover() {
  receipt=$1
  [[ -f "$receipt" && ! -L "$receipt" ]] || { echo "missing regular recovery receipt" >&2; exit 1; }
  bucket_name=$(awk -F= '$1=="bucket" {print $2}' "$receipt")
  lock_table_name=$(awk -F= '$1=="table" {print $2}' "$receipt")
  region=$(awk -F= '$1=="region" {print $2}' "$receipt")
  cleanup_bucket=$(awk -F= '$1=="cleanup_bucket" {print $2}' "$receipt")
  cleanup_table=$(awk -F= '$1=="cleanup_table" {print $2}' "$receipt")
  [[ -n "$bucket_name" && -n "$lock_table_name" && -n "$region" ]] || usage
  if cleanup_resources; then
    rm -f -- "$receipt"
    echo "recovery cleanup completed" >&2
    exit 0
  fi
  echo "recovery cleanup remains incomplete; retain the recovery receipt" >&2
  exit 1
}

[[ $# -ge 2 ]] || usage
if [[ $1 == "--recover" ]]; then
  [[ $# -eq 2 ]] || usage
  recover "$2"
fi
[[ $1 == "--create" && $# -eq 6 ]] || usage
bucket_name=$2
lock_table_name=$3
region=$4
state_kms_key_id=$5
receipt=$6
for value in "$bucket_name" "$lock_table_name" "$region" "$state_kms_key_id" "$receipt"; do
  [[ -n "$value" ]] || usage
done
[[ ! -e "$receipt" && ! -L "$receipt" ]] || { echo "refusing to overwrite recovery receipt" >&2; exit 1; }

bucket_check=$(aws s3api head-bucket --bucket "$bucket_name" 2>&1) && {
  echo "refusing to overwrite existing state bucket" >&2; exit 1;
}
grep -Eq "(404|Not Found|NoSuchBucket)" <<<"$bucket_check" || {
  echo "unable to verify that the state bucket is absent" >&2; exit 1;
}
table_check=$(aws dynamodb describe-table --table-name "$lock_table_name" --region "$region" 2>&1) && {
  echo "refusing to overwrite existing lock table" >&2; exit 1;
}
grep -q "ResourceNotFoundException" <<<"$table_check" || {
  echo "unable to verify that the lock table is absent" >&2; exit 1;
}

trap cleanup_on_failure ERR INT TERM
write_receipt
if [[ "$region" == "us-east-1" ]]; then
  aws s3api create-bucket --bucket "$bucket_name" --region "$region"
else
  aws s3api create-bucket --bucket "$bucket_name" --region "$region" \
    --create-bucket-configuration "LocationConstraint=$region"
fi
cleanup_bucket=true
write_receipt
aws s3api put-public-access-block --bucket "$bucket_name" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$bucket_name" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$bucket_name" \
  --server-side-encryption-configuration "Rules=[{ApplyServerSideEncryptionByDefault={SSEAlgorithm=aws:kms,KMSMasterKeyID=$state_kms_key_id},BucketKeyEnabled=true}]"

aws dynamodb create-table --table-name "$lock_table_name" --region "$region" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST \
  --sse-specification Enabled=true,SSEType=KMS,KMSMasterKeyId="$state_kms_key_id"
cleanup_table=true
write_receipt
aws dynamodb wait table-exists --table-name "$lock_table_name" --region "$region"

public_block=$(aws s3api get-public-access-block --bucket "$bucket_name" \
  --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' --output text)
[[ "$public_block" == $'True\tTrue\tTrue\tTrue' ]] || { echo "state bucket public access block verification failed" >&2; exit 1; }
[[ "$(aws s3api get-bucket-versioning --bucket "$bucket_name" --query Status --output text)" == "Enabled" ]] || {
  echo "state bucket versioning verification failed" >&2; exit 1;
}
encryption=$(aws s3api get-bucket-encryption --bucket "$bucket_name" \
  --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.[SSEAlgorithm,KMSMasterKeyID]' --output text)
[[ "$encryption" == $'aws:kms\t'"$state_kms_key_id" ]] || { echo "state bucket encryption verification failed" >&2; exit 1; }
table_state=$(aws dynamodb describe-table --table-name "$lock_table_name" --region "$region" \
  --query 'Table.[TableStatus,SSEDescription.Status,SSEDescription.KMSMasterKeyArn]' --output text)
[[ "$table_state" == ACTIVE$'\t'ENABLED$'\t'* ]] || { echo "lock table readiness or SSE verification failed" >&2; exit 1; }

cleanup_bucket=false
cleanup_table=false
write_receipt
trap - ERR INT TERM
echo "verified state storage created; retain the recovery receipt and stop before migration" >&2
