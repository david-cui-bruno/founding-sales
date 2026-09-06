#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <bucket-name> <lock-table-name> <region> <state-kms-key-id>" >&2
  exit 1
}

[[ $# -eq 4 ]] || usage
bucket_name=$1
lock_table_name=$2
region=$3
state_kms_key_id=$4

for value in "$bucket_name" "$lock_table_name" "$region" "$state_kms_key_id"; do
  [[ -n "$value" ]] || usage
done

refuse_existing_bucket() {
  local output
  if output=$(aws s3api head-bucket --bucket "$bucket_name" 2>&1); then
    echo "refusing to overwrite existing state bucket" >&2
    exit 1
  fi
  if ! grep -Eq "(404|Not Found|NoSuchBucket)" <<<"$output"; then
    echo "unable to verify that the state bucket is absent" >&2
    exit 1
  fi
}

refuse_existing_table() {
  local output
  if output=$(aws dynamodb describe-table \
    --table-name "$lock_table_name" \
    --region "$region" 2>&1); then
    echo "refusing to overwrite existing lock table" >&2
    exit 1
  fi
  if ! grep -q "ResourceNotFoundException" <<<"$output"; then
    echo "unable to verify that the lock table is absent" >&2
    exit 1
  fi
}

refuse_existing_bucket
refuse_existing_table

if [[ "$region" == "us-east-1" ]]; then
  aws s3api create-bucket --bucket "$bucket_name" --region "$region"
else
  aws s3api create-bucket \
    --bucket "$bucket_name" \
    --region "$region" \
    --create-bucket-configuration "LocationConstraint=$region"
fi

aws s3api put-public-access-block \
  --bucket "$bucket_name" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-versioning \
  --bucket "$bucket_name" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$bucket_name" \
  --server-side-encryption-configuration \
  "Rules=[{ApplyServerSideEncryptionByDefault={SSEAlgorithm=aws:kms,KMSMasterKeyID=$state_kms_key_id},BucketKeyEnabled=true}]"

aws dynamodb create-table \
  --table-name "$lock_table_name" \
  --region "$region" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --sse-specification Enabled=true,SSEType=KMS,KMSMasterKeyId="$state_kms_key_id"

echo "state storage created; stop before migration and obtain the second explicit confirmation" >&2
