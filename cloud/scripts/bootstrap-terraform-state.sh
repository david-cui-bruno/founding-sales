#!/usr/bin/env bash
set -euo pipefail

receipt_format="callie-terraform-state-bootstrap"
receipt_version="1"
expected_account_id="326255650484"
expected_table="callie-sourcing-tflock"
ownership_marker="terraform-state-v1"

usage() {
  echo "usage: $0 --create <region> <kms-key-arn> <recovery-receipt> | --recover <recovery-receipt>" >&2
  exit 1
}

receipt=""
account_id="$expected_account_id"
region=""
run_id=""
bucket_name=""
lock_table_name="$expected_table"
kms_key_arn=""
bucket_phase="absent"
table_phase="absent"

write_receipt() {
  local temporary_receipt="${receipt}.tmp.$$"
  umask 077
  printf 'format=%s\nversion=%s\naccount_id=%s\nregion=%s\nrun_id=%s\nbucket=%s\ntable=%s\nkms_key_arn=%s\nbucket_phase=%s\ntable_phase=%s\n' \
    "$receipt_format" "$receipt_version" "$account_id" "$region" "$run_id" \
    "$bucket_name" "$lock_table_name" "$kms_key_arn" "$bucket_phase" "$table_phase" >"$temporary_receipt" || {
      rm -f -- "$temporary_receipt"
      return 1
    }
  chmod 0600 "$temporary_receipt" || {
    rm -f -- "$temporary_receipt"
    return 1
  }
  mv -f -- "$temporary_receipt" "$receipt" || {
    rm -f -- "$temporary_receipt"
    return 1
  }
}

persist_bucket_phase() {
  local next_phase=$1 previous_phase=$bucket_phase
  bucket_phase=$next_phase
  write_receipt || { bucket_phase=$previous_phase; return 1; }
}

persist_table_phase() {
  local next_phase=$1 previous_phase=$table_phase
  table_phase=$next_phase
  write_receipt || { table_phase=$previous_phase; return 1; }
}

receipt_value() {
  local key=$1
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$receipt"
}

validate_receipt() {
  [[ -f "$receipt" && ! -L "$receipt" ]] || { echo "missing regular nonsymlink recovery receipt" >&2; return 1; }
  [[ "$(stat -f '%Lp' "$receipt")" == "600" ]] || { echo "receipt must be mode 0600" >&2; return 1; }

  local observed_format observed_version expected_bucket
  observed_format=$(receipt_value format)
  observed_version=$(receipt_value version)
  account_id=$(receipt_value account_id)
  region=$(receipt_value region)
  run_id=$(receipt_value run_id)
  bucket_name=$(receipt_value bucket)
  lock_table_name=$(receipt_value table)
  kms_key_arn=$(receipt_value kms_key_arn)
  bucket_phase=$(receipt_value bucket_phase)
  table_phase=$(receipt_value table_phase)
  expected_bucket="callie-sourcing-tfstate-${account_id}"

  [[ "$observed_format" == "$receipt_format" && "$observed_version" == "$receipt_version" ]] || {
    echo "invalid bootstrap receipt format or version" >&2; return 1;
  }
  [[ "$account_id" == "$expected_account_id" && "$region" == "us-east-1" ]] || {
    echo "receipt account or region does not match the approved target" >&2; return 1;
  }
  [[ "$run_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
    echo "invalid canonical bootstrap run id" >&2; return 1;
  }
  [[ "$bucket_name" == "$expected_bucket" && "$lock_table_name" == "$expected_table" ]] || {
    echo "receipt resource names do not match exact expected names" >&2; return 1;
  }
  [[ "$kms_key_arn" =~ ^arn:aws:kms:us-east-1:${expected_account_id}:key/[0-9a-f-]{36}$ ]] || {
    echo "receipt KMS key ARN is not canonical for the approved account" >&2; return 1;
  }
  [[ "$bucket_phase" =~ ^(absent|pending|owned|verified)$ && "$table_phase" =~ ^(absent|pending|owned|verified)$ ]] || {
    echo "receipt contains an invalid resource phase" >&2; return 1;
  }
}

verify_bucket_ownership() {
  local run_tag owner_tag
  run_tag=$(aws s3api get-bucket-tagging --bucket "$bucket_name" \
    --query "TagSet[?Key=='CallieBootstrapRunId'].Value | [0]" --output text 2>/dev/null) || return 1
  owner_tag=$(aws s3api get-bucket-tagging --bucket "$bucket_name" \
    --query "TagSet[?Key=='CallieBootstrap'].Value | [0]" --output text 2>/dev/null) || return 1
  [[ "$run_tag" == "$run_id" && "$owner_tag" == "$ownership_marker" ]]
}

verify_table_ownership() {
  local table_arn run_tag owner_tag
  table_arn=$(aws dynamodb describe-table --table-name "$lock_table_name" --region "$region" \
    --query Table.TableArn --output text 2>/dev/null) || return 1
  run_tag=$(aws dynamodb list-tags-of-resource --resource-arn "$table_arn" \
    --query "Tags[?Key=='CallieBootstrapRunId'].Value | [0]" --output text 2>/dev/null) || return 1
  owner_tag=$(aws dynamodb list-tags-of-resource --resource-arn "$table_arn" \
    --query "Tags[?Key=='CallieBootstrap'].Value | [0]" --output text 2>/dev/null) || return 1
  [[ "$run_tag" == "$run_id" && "$owner_tag" == "$ownership_marker" ]]
}

verify_bucket_absent() {
  local output
  if output=$(aws s3api head-bucket --bucket "$bucket_name" 2>&1); then
    return 1
  fi
  grep -Eq "(404|Not Found|NoSuchBucket)" <<<"$output"
}

verify_table_absent() {
  local output
  if output=$(aws dynamodb describe-table --table-name "$lock_table_name" --region "$region" 2>&1); then
    return 1
  fi
  grep -q "ResourceNotFoundException" <<<"$output"
}

reconcile_bucket() {
  local output
  if aws s3api head-bucket --bucket "$bucket_name" >/dev/null 2>&1; then
    if ! verify_bucket_ownership; then
      echo "ambiguous bucket ownership; retaining recovery receipt" >&2
      return 1
    fi
    persist_bucket_phase "owned" || { echo "failed to persist bucket recovery phase; retaining recovery receipt" >&2; return 1; }
    if ! verify_bucket_ownership; then
      echo "bucket ownership changed before delete; retaining recovery receipt" >&2
      return 1
    fi
    if ! aws s3api delete-bucket --bucket "$bucket_name" --region "$region"; then
      echo "bucket delete failed; retaining recovery receipt" >&2
      return 1
    fi
    if ! verify_bucket_absent; then
      echo "bucket absence could not be proven after delete; retaining recovery receipt" >&2
      return 1
    fi
    persist_bucket_phase "absent" || { echo "failed to persist bucket absence; retaining recovery receipt" >&2; return 1; }
    return 0
  fi
  output=$(aws s3api head-bucket --bucket "$bucket_name" 2>&1) || true
  if grep -Eq "(404|Not Found|NoSuchBucket)" <<<"$output"; then
    persist_bucket_phase "absent" || { echo "failed to persist bucket absence; retaining recovery receipt" >&2; return 1; }
    return 0
  fi
  echo "ambiguous bucket existence; retaining recovery receipt" >&2
  return 1
}

reconcile_table() {
  local output table_arn
  if table_arn=$(aws dynamodb describe-table --table-name "$lock_table_name" --region "$region" \
    --query Table.TableArn --output text 2>/dev/null); then
    [[ -n "$table_arn" && "$table_arn" != "None" ]] || { echo "ambiguous lock-table identity; retaining recovery receipt" >&2; return 1; }
    if ! verify_table_ownership; then
      echo "ambiguous lock-table ownership; retaining recovery receipt" >&2
      return 1
    fi
    persist_table_phase "owned" || { echo "failed to persist lock-table recovery phase; retaining recovery receipt" >&2; return 1; }
    if ! verify_table_ownership; then
      echo "lock-table ownership changed before delete; retaining recovery receipt" >&2
      return 1
    fi
    if ! aws dynamodb delete-table --table-name "$lock_table_name" --region "$region" >/dev/null; then
      echo "lock-table delete failed; retaining recovery receipt" >&2
      return 1
    fi
    if ! aws dynamodb wait table-not-exists --table-name "$lock_table_name" --region "$region"; then
      echo "lock-table deletion waiter failed; retaining recovery receipt" >&2
      return 1
    fi
    if ! verify_table_absent; then
      echo "lock-table absence could not be proven after delete; retaining recovery receipt" >&2
      return 1
    fi
    persist_table_phase "absent" || { echo "failed to persist lock-table absence; retaining recovery receipt" >&2; return 1; }
    return 0
  fi
  output=$(aws dynamodb describe-table --table-name "$lock_table_name" --region "$region" 2>&1) || true
  if grep -q "ResourceNotFoundException" <<<"$output"; then
    persist_table_phase "absent" || { echo "failed to persist lock-table absence; retaining recovery receipt" >&2; return 1; }
    return 0
  fi
  echo "ambiguous lock-table existence; retaining recovery receipt" >&2
  return 1
}

recover_resources() {
  local failed=false
  reconcile_table || failed=true
  reconcile_bucket || failed=true
  [[ "$failed" == false && "$table_phase" == "absent" && "$bucket_phase" == "absent" ]]
}

cleanup_on_failure() {
  trap - ERR INT TERM
  recover_resources || {
    echo "automatic cleanup is ambiguous or incomplete; retaining recovery receipt" >&2
    exit 1
  }
  echo "automatic cleanup completed; retaining recovery receipt as evidence" >&2
  exit 1
}

verify_postconditions() {
  local public_block versioning bucket_encryption observed_table_status observed_table_sse observed_table_kms_arn
  verify_bucket_ownership || return 1
  verify_table_ownership || return 1
  public_block=$(aws s3api get-public-access-block --bucket "$bucket_name" \
    --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' --output text) || return 1
  [[ "$public_block" == $'True\tTrue\tTrue\tTrue' ]] || return 1
  versioning=$(aws s3api get-bucket-versioning --bucket "$bucket_name" --query Status --output text) || return 1
  [[ "$versioning" == "Enabled" ]] || return 1
  bucket_encryption=$(aws s3api get-bucket-encryption --bucket "$bucket_name" \
    --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.[SSEAlgorithm,KMSMasterKeyID]' --output text) || return 1
  [[ "$bucket_encryption" == $'aws:kms\t'"$kms_key_arn" ]] || return 1
  observed_table_status=$(aws dynamodb describe-table --table-name "$lock_table_name" --region "$region" --query Table.TableStatus --output text) || return 1
  observed_table_sse=$(aws dynamodb describe-table --table-name "$lock_table_name" --region "$region" --query Table.SSEDescription.Status --output text) || return 1
  observed_table_kms_arn=$(aws dynamodb describe-table --table-name "$lock_table_name" --region "$region" --query Table.SSEDescription.KMSMasterKeyArn --output text) || return 1
  [[ "$observed_table_status" == "ACTIVE" && "$observed_table_sse" == "ENABLED" ]] || return 1
  [[ "$observed_table_kms_arn" == "$kms_key_arn" ]] || return 1
}

[[ $# -ge 2 ]] || usage
if [[ $1 == "--recover" ]]; then
  [[ $# -eq 2 ]] || usage
  receipt=$2
  validate_receipt
  [[ "$bucket_phase" != "verified" && "$table_phase" != "verified" ]] || {
    echo "verified resources are not eligible for recovery deletion; retaining recovery receipt" >&2
    exit 1
  }
  if recover_resources; then
    echo "recovery reconciliation completed; retaining recovery receipt as evidence" >&2
    exit 0
  fi
  echo "recovery remains ambiguous or incomplete; retaining recovery receipt" >&2
  exit 1
fi

[[ $1 == "--create" && $# -eq 4 ]] || usage
region=$2
kms_key_arn=$3
receipt=$4
[[ "$region" == "us-east-1" ]] || { echo "state bootstrap region must be us-east-1" >&2; exit 1; }
[[ "$kms_key_arn" =~ ^arn:aws:kms:us-east-1:${expected_account_id}:key/[0-9a-f-]{36}$ ]] || {
  echo "state KMS key ARN must be canonical for the approved account" >&2; exit 1;
}
[[ ! -e "$receipt" && ! -L "$receipt" ]] || { echo "refusing to overwrite recovery receipt" >&2; exit 1; }
run_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
[[ "$run_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo "uuidgen did not produce a canonical version-4 run id" >&2; exit 1;
}
bucket_name="callie-sourcing-tfstate-${account_id}"
write_receipt || { echo "failed to create recovery receipt" >&2; exit 1; }
validate_receipt

trap cleanup_on_failure ERR INT TERM
bucket_phase="pending"
write_receipt || { echo "failed to persist pending bucket phase" >&2; exit 1; }
if [[ "$region" == "us-east-1" ]]; then
  aws s3api create-bucket --bucket "$bucket_name" --region "$region"
else
  aws s3api create-bucket --bucket "$bucket_name" --region "$region" \
    --create-bucket-configuration "LocationConstraint=$region"
fi
aws s3api put-bucket-tagging --bucket "$bucket_name" --tagging \
  "TagSet=[{Key=CallieBootstrapRunId,Value=${run_id}},{Key=CallieBootstrap,Value=${ownership_marker}}]"
bucket_phase="owned"
write_receipt || {
  echo "failed to persist owned bucket phase; starting cleanup" >&2
  cleanup_on_failure
}
aws s3api put-public-access-block --bucket "$bucket_name" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$bucket_name" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$bucket_name" \
  --server-side-encryption-configuration "Rules=[{ApplyServerSideEncryptionByDefault={SSEAlgorithm=aws:kms,KMSMasterKeyID=$kms_key_arn},BucketKeyEnabled=true}]"

table_phase="pending"
write_receipt || {
  echo "failed to persist pending lock-table phase; starting cleanup" >&2
  cleanup_on_failure
}
aws dynamodb create-table --table-name "$lock_table_name" --region "$region" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST \
  --sse-specification Enabled=true,SSEType=KMS,KMSMasterKeyId="$kms_key_arn" \
  --tags Key=CallieBootstrapRunId,Value="$run_id" Key=CallieBootstrap,Value="$ownership_marker"
table_phase="owned"
write_receipt || {
  echo "failed to persist owned lock-table phase; starting cleanup" >&2
  cleanup_on_failure
}
aws dynamodb wait table-exists --table-name "$lock_table_name" --region "$region"

trap - ERR INT TERM
if ! verify_postconditions; then
  echo "postcondition verification failed; retaining recovery receipt" >&2
  exit 1
fi
bucket_phase="verified"
table_phase="verified"
write_receipt || { echo "failed to persist verified resource phases; retaining recovery receipt" >&2; exit 1; }
echo "verified state storage created; retain the recovery receipt and stop before migration" >&2
