#!/usr/bin/env bash
set -euo pipefail

alias_name="alias/callie-sourcing-runtime-secrets"
parameter_names=(
  "TRACERFY_API_KEY_PARAM=/callie-sourcing/tracerfy-api-key"
  "NTFY_TOPIC_PARAM=/callie-sourcing/ntfy-topic"
  "HMAC_SALT_PARAM=/callie-sourcing/membership-hmac-salt"
)

usage() {
  echo "usage: $0 --prepare <region> <receipt-file> | --verify-parameters <region> <receipt-file>" >&2
  exit 1
}

[[ $# -eq 3 ]] || usage
mode=$1
region=$2
receipt=$3
[[ "$mode" == "--prepare" || "$mode" == "--verify-parameters" ]] || usage
[[ -n "$region" && -n "$receipt" && ! -L "$receipt" ]] || usage

read_receipt_value() {
  local key=$1
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$receipt"
}

if [[ "$mode" == "--prepare" ]]; then
  [[ ! -e "$receipt" ]] || { echo "refusing to overwrite runtime-key receipt" >&2; exit 1; }
  alias_check=$(aws kms describe-key --key-id "$alias_name" --region "$region" 2>&1) && {
    echo "refusing to replace existing runtime-secret key alias" >&2
    exit 1
  }
  grep -q "NotFoundException" <<<"$alias_check" || {
    echo "unable to prove runtime-secret key alias is absent" >&2
    exit 1
  }

  key_id=""
  alias_created=false
  cleanup_key() {
    trap - ERR INT TERM
    if [[ "$alias_created" == true ]]; then
      aws kms delete-alias --alias-name "$alias_name" --region "$region" >/dev/null || true
    fi
    if [[ -n "$key_id" ]]; then
      aws kms schedule-key-deletion --key-id "$key_id" --pending-window-in-days 30 --region "$region" >/dev/null || true
    fi
    echo "runtime-secret key preparation failed; alias removed and created key scheduled for deletion" >&2
    exit 1
  }
  trap cleanup_key ERR INT TERM

  key_id=$(aws kms create-key \
    --description "KMS key for callie-sourcing runtime SecureString parameters" \
    --region "$region" \
    --query KeyMetadata.KeyId \
    --output text)
  aws kms enable-key-rotation --key-id "$key_id" --region "$region"
  for _ in {1..30}; do
    key_state=$(aws kms describe-key --key-id "$key_id" --region "$region" --query KeyMetadata.KeyState --output text)
    [[ "$key_state" == "Enabled" ]] && break
    sleep 2
  done
  [[ "${key_state:-}" == "Enabled" ]] || { echo "runtime-secret key did not become enabled" >&2; exit 1; }
  aws kms create-alias --alias-name "$alias_name" --target-key-id "$key_id" --region "$region"
  alias_created=true
  key_arn=$(aws kms describe-key --key-id "$alias_name" --region "$region" --query KeyMetadata.Arn --output text)
  umask 077
  printf 'region=%s\nalias=%s\nkey_id=%s\nkey_arn=%s\n' \
    "$region" "$alias_name" "$key_id" "$key_arn" >"$receipt"
  chmod 0600 "$receipt"
  trap - ERR INT TERM
  echo "runtime-secret key prepared; stop before entering parameters" >&2
  exit 0
fi

[[ -f "$receipt" && ! -L "$receipt" ]] || { echo "missing regular runtime-key receipt" >&2; exit 1; }
[[ "$(stat -f '%Lp' "$receipt")" == "600" ]] || { echo "runtime-key receipt must be mode 0600" >&2; exit 1; }
receipt_region=$(read_receipt_value region)
receipt_alias=$(read_receipt_value alias)
receipt_key_id=$(read_receipt_value key_id)
receipt_key_arn=$(read_receipt_value key_arn)
[[ "$receipt_region" == "$region" && "$receipt_alias" == "$alias_name" && -n "$receipt_key_id" && -n "$receipt_key_arn" ]] || {
  echo "runtime-key receipt does not match requested verification" >&2
  exit 1
}
actual_key_id=$(aws kms describe-key --key-id "$alias_name" --region "$region" --query KeyMetadata.KeyId --output text)
[[ "$actual_key_id" == "$receipt_key_id" ]] || { echo "runtime-key alias target changed" >&2; exit 1; }
actual_key_arn=$(aws kms describe-key --key-id "$alias_name" --region "$region" --query KeyMetadata.Arn --output text)
[[ "$actual_key_arn" == "$receipt_key_arn" ]] || { echo "runtime-key alias ARN changed" >&2; exit 1; }
rotation_enabled=$(aws kms get-key-rotation-status --key-id "$receipt_key_id" --region "$region" --query KeyRotationEnabled --output text)
[[ "$rotation_enabled" == "True" ]] || { echo "runtime-key rotation is not enabled" >&2; exit 1; }
account_id=$(cut -d: -f5 <<<"$receipt_key_arn")
[[ "$receipt_key_arn" == "arn:aws:kms:${region}:${account_id}:key/${receipt_key_id}" && "$account_id" =~ ^[0-9]{12}$ ]] || {
  echo "runtime-key receipt ARN is not canonical" >&2
  exit 1
}

for mapping in "${parameter_names[@]}"; do
  parameter=${mapping#*=}
  expected_parameter_arn="arn:aws:ssm:${region}:${account_id}:parameter${parameter}"
  metadata_output=$(aws ssm describe-parameters \
    --parameter-filters "Key=Name,Option=Equals,Values=${parameter}" \
    --region "$region" \
    --query 'Parameters[].[Name,Type,KeyId,ARN]' \
    --output text)
  metadata_row_count=$(printf '%s\n' "$metadata_output" | awk 'NF { count += 1 } END { print count + 0 }')
  [[ "$metadata_row_count" -eq 1 ]] || {
    echo "parameter metadata did not resolve to exactly one row" >&2
    exit 1
  }
  IFS=$'\t' read -r metadata_name metadata_type metadata_key_id metadata_arn <<<"$metadata_output"
  [[ "$metadata_name" == "$parameter" && "$metadata_type" == "SecureString" && "$metadata_arn" == "$expected_parameter_arn" ]] || {
    echo "parameter metadata identity or type mismatch" >&2
    exit 1
  }
  metadata_key_id=$(aws kms describe-key --key-id "$metadata_key_id" --region "$region" --query KeyMetadata.KeyId --output text)
  metadata_key_arn=$(aws kms describe-key --key-id "$metadata_key_id" --region "$region" --query KeyMetadata.Arn --output text)
  [[ "$metadata_key_id" == "$receipt_key_id" && "$metadata_key_arn" == "$receipt_key_arn" ]] || {
    echo "parameter is not encrypted by the prepared runtime key" >&2
    exit 1
  }
  decrypted_parameter_arn=$(aws ssm get-parameter \
    --name "$parameter" \
    --with-decryption \
    --region "$region" \
    --query Parameter.ARN \
    --output text)
  [[ "$decrypted_parameter_arn" == "$expected_parameter_arn" ]] || {
    echo "decrypted parameter identity mismatch" >&2
    exit 1
  }
done
echo "all runtime parameter identifiers and decrypt access prevalidated; no values displayed" >&2
