#!/usr/bin/env bash
set -euo pipefail

receipt_format="callie-runtime-secret-key-bootstrap"
receipt_version="1"
alias_name="alias/callie-sourcing-runtime-secrets"
ownership_marker="runtime-secret-key-v1"
parameter_names=(
  "TRACERFY_API_KEY_PARAM=/callie-sourcing/tracerfy-api-key"
  "NTFY_TOPIC_PARAM=/callie-sourcing/ntfy-topic"
  "HMAC_SALT_PARAM=/callie-sourcing/membership-hmac-salt"
)

usage() {
  echo "usage: $0 --prepare <region> <receipt-file> | --recover <receipt-file> | --verify-parameters <region> <receipt-file>" >&2
  exit 1
}

receipt=""
receipt_directory=""
receipt_basename=""
region=""
run_id=""
phase=""
key_id=""
key_arn=""

bind_receipt_boundary() {
  local supplied_directory supplied_basename canonical_home expected_directory canonical_directory
  local effective_uid path_component current_path directory_type directory_owner directory_mode mode_value acl_output acl_line
  local -a path_components
  supplied_directory=$(dirname -- "$receipt") || return 1
  supplied_basename=$(basename -- "$receipt") || return 1
  [[ "$supplied_basename" != "." && "$supplied_basename" != ".." && "$supplied_basename" != .* ]] || {
    echo "runtime-key receipt basename must be one non-dot leaf" >&2; return 1;
  }
  [[ -d "$supplied_directory" && ! -L "$supplied_directory" ]] || {
    echo "runtime-key receipt parent must be an existing nonsymlink directory" >&2; return 1;
  }
  [[ -n "${HOME:-}" && -d "$HOME" ]] || { echo "HOME must resolve from an existing directory" >&2; return 1; }
  canonical_home=$(cd -P -- "$HOME" && pwd -P) || return 1
  expected_directory="${canonical_home}/.callie-bootstrap-receipts"
  canonical_directory=$(cd -P -- "$supplied_directory" && pwd -P) || return 1
  [[ "$canonical_directory" == "$expected_directory" ]] || {
    echo "runtime-key receipt parent must be canonical HOME/.callie-bootstrap-receipts" >&2; return 1;
  }
  effective_uid=$(id -u) || return 1
  IFS='/' read -r -a path_components <<<"${canonical_directory#/}"
  path_components=("" "${path_components[@]}")
  current_path="/"
  for path_component in "${path_components[@]}"; do
    if [[ -n "$path_component" && "$current_path" == "/" ]]; then current_path="/${path_component}"
    elif [[ -n "$path_component" ]]; then current_path="${current_path}/${path_component}"
    fi
    [[ -d "$current_path" && ! -L "$current_path" ]] || {
      echo "runtime-key receipt ancestor must be a real nonsymlink directory" >&2; return 1;
    }
    directory_type=$(stat -f '%HT' "$current_path") || return 1
    directory_owner=$(stat -f '%u' "$current_path") || return 1
    directory_mode=$(stat -f '%Lp' "$current_path") || return 1
    [[ "$directory_type" == "Directory" && ( "$directory_owner" == "0" || "$directory_owner" == "$effective_uid" ) ]] || {
      echo "runtime-key receipt ancestor must be owned by root or the effective user" >&2; return 1;
    }
    mode_value=$((8#$directory_mode)) || return 1
    (( (mode_value & 8#022) == 0 )) || {
      echo "runtime-key receipt ancestor must not be group- or other-writable" >&2; return 1;
    }
    acl_output=$(/bin/ls -lde "$current_path") || return 1
    while IFS= read -r acl_line; do
      if [[ "$acl_line" =~ ^[[:space:]]*[0-9]+:.*[[:space:]]allow[[:space:]] ]]; then
        echo "runtime-key receipt ancestor must not contain allow ACL entries" >&2; return 1
      fi
    done <<<"$acl_output"
  done
  [[ "$directory_owner" == "$effective_uid" && "$directory_mode" == "700" ]] || {
    echo "runtime-key receipt parent must be owned by the effective user with exact mode 0700" >&2; return 1;
  }
  receipt_directory=$canonical_directory
  receipt_basename=$supplied_basename
  receipt="${receipt_directory}/${receipt_basename}"
}

receipt_value() {
  local key=$1
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$receipt"
}

write_receipt() {
  local create_mode=${1:-replace} temporary_receipt temporary_directory temporary_basename temporary_prefix temporary_suffix temporary_type temporary_mode installed_type installed_mode
  bind_receipt_boundary || return 1
  umask 077
  if [[ "$create_mode" == "create" ]]; then
    ( set -C; : > "$receipt" ) 2>/dev/null || { echo "refusing to overwrite runtime-key receipt" >&2; return 1; }
    chmod 0600 "$receipt" || return 1
  else
    [[ -f "$receipt" && ! -L "$receipt" && "$(stat -f '%Lp' "$receipt")" == "600" ]] || return 1
  fi
  temporary_receipt=$(mktemp "${receipt_directory}/.${receipt_basename}.tmp.XXXXXXXX") || return 1
  temporary_directory=$(dirname -- "$temporary_receipt") || return 1
  temporary_basename=$(basename -- "$temporary_receipt") || return 1
  temporary_prefix=".${receipt_basename}.tmp."
  temporary_suffix=${temporary_basename#"$temporary_prefix"}
  [[ "$temporary_directory" == "$receipt_directory" && "$temporary_basename" == "$temporary_prefix"* && "$temporary_suffix" =~ ^[[:alnum:]]{8}$ ]] || {
    rm -f -- "$temporary_receipt"; return 1;
  }
  temporary_type=$(stat -f '%HT' "$temporary_receipt") || { rm -f -- "$temporary_receipt"; return 1; }
  temporary_mode=$(stat -f '%Lp' "$temporary_receipt") || { rm -f -- "$temporary_receipt"; return 1; }
  [[ ! -L "$temporary_receipt" && -f "$temporary_receipt" && "$temporary_type" == "Regular File" && "$temporary_mode" == "600" ]] || {
    rm -f -- "$temporary_receipt"; return 1;
  }
  printf 'format=%s\nversion=%s\nregion=%s\nrun_id=%s\nalias=%s\nphase=%s\nkey_id=%s\nkey_arn=%s\n' \
    "$receipt_format" "$receipt_version" "$region" "$run_id" "$alias_name" "$phase" "$key_id" "$key_arn" >"$temporary_receipt" || {
      rm -f -- "$temporary_receipt"; return 1;
    }
  chmod 0600 "$temporary_receipt" || { rm -f -- "$temporary_receipt"; return 1; }
  bind_receipt_boundary || { rm -f -- "$temporary_receipt"; return 1; }
  [[ -f "$receipt" && ! -L "$receipt" ]] || { rm -f -- "$temporary_receipt"; return 1; }
  mv -f -- "$temporary_receipt" "$receipt" || { rm -f -- "$temporary_receipt"; return 1; }
  installed_type=$(stat -f '%HT' "$receipt") || return 1
  installed_mode=$(stat -f '%Lp' "$receipt") || return 1
  [[ ! -L "$receipt" && -f "$receipt" && "$installed_type" == "Regular File" && "$installed_mode" == "600" ]]
}

persist_phase() {
  local next_phase=$1 previous_phase=$phase
  phase=$next_phase
  write_receipt replace || { phase=$previous_phase; return 1; }
}

load_receipt() {
  bind_receipt_boundary || return 1
  [[ -f "$receipt" && ! -L "$receipt" && "$(stat -f '%Lp' "$receipt")" == "600" ]] || {
    echo "missing mode-0600 regular runtime-key receipt" >&2; return 1;
  }
  [[ "$(receipt_value format)" == "$receipt_format" && "$(receipt_value version)" == "$receipt_version" ]] || return 1
  region=$(receipt_value region)
  run_id=$(receipt_value run_id)
  phase=$(receipt_value phase)
  key_id=$(receipt_value key_id)
  key_arn=$(receipt_value key_arn)
  [[ "$(receipt_value alias)" == "$alias_name" && "$region" == "us-east-1" ]] || return 1
  [[ "$run_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1
  [[ "$phase" =~ ^(pending-key|key-owned|pending-alias|verified|cleanup-verified)$ ]] || return 1
}

key_has_ownership() {
  local candidate=$1 tags
  tags=$(aws kms list-resource-tags --key-id "$candidate" --region "$region" --query 'Tags[].[TagKey,TagValue]' --output text 2>/dev/null) || return 1
  grep -Fqx $'CallieBootstrapRunId\t'"$run_id" <<<"$tags" && grep -Fqx $'CallieBootstrap\t'"$ownership_marker" <<<"$tags"
}

reconcile_owned_key() {
  local candidate found=""
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if key_has_ownership "$candidate"; then
      [[ -z "$found" ]] || { echo "multiple runtime keys match the recovery run id" >&2; return 1; }
      found=$candidate
    fi
  done < <(aws kms list-keys --region "$region" --query 'Keys[].KeyId' --output text | tr '\t' '\n')
  [[ -n "$found" ]] || return 1
  key_id=$found
  key_arn=$(aws kms describe-key --key-id "$key_id" --region "$region" --query KeyMetadata.Arn --output text)
}

alias_is_absent() {
  local output
  output=$(aws kms describe-key --key-id "$alias_name" --region "$region" 2>&1) && return 1
  grep -q "NotFoundException" <<<"$output"
}

key_is_pending_deletion() {
  local candidate=$1 key_state deletion_date
  key_state=$(aws kms describe-key --key-id "$candidate" --region "$region" --query KeyMetadata.KeyState --output text) || return 1
  deletion_date=$(aws kms describe-key --key-id "$candidate" --region "$region" --query KeyMetadata.DeletionDate --output text) || return 1
  [[ "$key_state" == "PendingDeletion" && -n "$deletion_date" && "$deletion_date" != "None" ]]
}

recover_cleanup() {
  local alias_target
  if [[ -z "$key_id" ]]; then reconcile_owned_key || { echo "unable to reconcile the owned runtime key" >&2; return 1; }; fi
  key_has_ownership "$key_id" || { echo "runtime key ownership tags do not match the receipt" >&2; return 1; }
  if ! alias_is_absent; then
    alias_target=$(aws kms describe-key --key-id "$alias_name" --region "$region" --query KeyMetadata.KeyId --output text) || return 1
    [[ "$alias_target" == "$key_id" ]] || { echo "runtime alias is not owned by this receipt" >&2; return 1; }
    key_has_ownership "$key_id" || { echo "runtime key ownership tags do not match the receipt" >&2; return 1; }
    aws kms delete-alias --alias-name "$alias_name" --region "$region" >/dev/null || return 1
    alias_is_absent || { echo "runtime alias absence was not verified" >&2; return 1; }
  fi
  key_has_ownership "$key_id" || { echo "runtime key ownership tags do not match the receipt" >&2; return 1; }
  if ! key_is_pending_deletion "$key_id"; then
    aws kms schedule-key-deletion --key-id "$key_id" --pending-window-in-days 30 --region "$region" >/dev/null || true
    key_is_pending_deletion "$key_id" || { echo "runtime key scheduled deletion was not verified" >&2; return 1; }
  fi
  persist_phase cleanup-verified || return 1
  echo "runtime-key recovery cleanup verified; alias absent and owned key scheduled for deletion" >&2
}

verify_cleanup_terminal() {
  [[ -n "$key_id" ]] || { echo "cleanup-verified receipt is missing its key id" >&2; return 1; }
  alias_is_absent || { echo "runtime alias absence was not verified" >&2; return 1; }
  key_has_ownership "$key_id" || { echo "runtime key ownership tags do not match the receipt" >&2; return 1; }
  key_is_pending_deletion "$key_id" || { echo "runtime key scheduled deletion was not verified" >&2; return 1; }
  echo "runtime-key recovery cleanup verified; alias absent and owned key scheduled for deletion" >&2
}

[[ $# -ge 2 ]] || usage
mode=$1
if [[ "$mode" == "--recover" ]]; then
  [[ $# -eq 2 ]] || usage
  receipt=$2
  load_receipt || { echo "invalid runtime-key recovery receipt" >&2; exit 1; }
  case "$phase" in
    pending-key|key-owned|pending-alias) recover_cleanup ;;
    cleanup-verified) verify_cleanup_terminal ;;
    verified) echo "verified runtime-key receipt is not eligible for recovery cleanup" >&2; exit 1 ;;
    *) echo "invalid runtime-key recovery phase" >&2; exit 1 ;;
  esac
  exit 0
fi
[[ $# -eq 3 ]] || usage
region=$2
receipt=$3
[[ "$mode" == "--prepare" || "$mode" == "--verify-parameters" ]] || usage
[[ -n "$region" && -n "$receipt" ]] || usage
[[ "$region" == "us-east-1" ]] || { echo "runtime-key bootstrap region must be us-east-1" >&2; exit 1; }
bind_receipt_boundary || exit 1

if [[ "$mode" == "--prepare" ]]; then
  [[ ! -e "$receipt" && ! -L "$receipt" ]] || { echo "refusing to overwrite runtime-key receipt; use --recover for an interrupted run" >&2; exit 1; }
  alias_is_absent || { echo "unable to prove runtime-secret key alias is absent" >&2; exit 1; }
  run_id=${CALLIE_BOOTSTRAP_RUN_ID:-$(uuidgen | tr '[:upper:]' '[:lower:]')}
  [[ "$run_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
    echo "invalid canonical runtime-key bootstrap run id" >&2; exit 1;
  }
  phase="pending-key"
  write_receipt create || exit 1
  if ! key_id=$(aws kms create-key \
    --description "KMS key for callie-sourcing runtime SecureString parameters" \
    --tags "TagKey=CallieBootstrapRunId,TagValue=${run_id}" "TagKey=CallieBootstrap,TagValue=${ownership_marker}" \
    --region "$region" --query KeyMetadata.KeyId --output text); then
    reconcile_owned_key && { persist_phase key-owned || true; }
    echo "ambiguous create-key outcome reconciled to durable receipt; run --recover" >&2
    exit 1
  fi
  key_arn=$(aws kms describe-key --key-id "$key_id" --region "$region" --query KeyMetadata.Arn --output text)
  key_has_ownership "$key_id" || { echo "created runtime key ownership tags are not exact" >&2; exit 1; }
  persist_phase key-owned
  aws kms enable-key-rotation --key-id "$key_id" --region "$region"
  key_state=""
  for _ in {1..30}; do
    key_state=$(aws kms describe-key --key-id "$key_id" --region "$region" --query KeyMetadata.KeyState --output text)
    [[ "$key_state" == "Enabled" ]] && break
    sleep 2
  done
  [[ "$key_state" == "Enabled" ]] || { echo "runtime-secret key did not become enabled; run --recover" >&2; exit 1; }
  persist_phase pending-alias
  if ! aws kms create-alias --alias-name "$alias_name" --target-key-id "$key_id" --region "$region"; then
    alias_target=$(aws kms describe-key --key-id "$alias_name" --region "$region" --query KeyMetadata.KeyId --output text 2>/dev/null || true)
    [[ "$alias_target" == "$key_id" ]] || { echo "ambiguous create-alias outcome could not be reconciled; run --recover" >&2; exit 1; }
    echo "ambiguous create-alias outcome reconciled to owned key; run --recover" >&2
    exit 1
  fi
  actual_key_id=$(aws kms describe-key --key-id "$alias_name" --region "$region" --query KeyMetadata.KeyId --output text)
  [[ "$actual_key_id" == "$key_id" ]] || { echo "runtime alias target verification failed; run --recover" >&2; exit 1; }
  key_arn=$(aws kms describe-key --key-id "$alias_name" --region "$region" --query KeyMetadata.Arn --output text)
  persist_phase verified
  echo "runtime-secret key prepared; stop before entering parameters" >&2
  exit 0
fi

load_receipt || { echo "invalid runtime-key receipt" >&2; exit 1; }
[[ "$phase" == "verified" ]] || { echo "runtime-key receipt is not verified for parameter checks" >&2; exit 1; }
receipt_region=$region
receipt_key_id=$key_id
receipt_key_arn=$key_arn
actual_key_id=$(aws kms describe-key --key-id "$alias_name" --region "$region" --query KeyMetadata.KeyId --output text)
[[ "$actual_key_id" == "$receipt_key_id" ]] || { echo "runtime-key alias target changed" >&2; exit 1; }
actual_key_arn=$(aws kms describe-key --key-id "$alias_name" --region "$region" --query KeyMetadata.Arn --output text)
[[ "$actual_key_arn" == "$receipt_key_arn" ]] || { echo "runtime-key alias ARN changed" >&2; exit 1; }
rotation_enabled=$(aws kms get-key-rotation-status --key-id "$receipt_key_id" --region "$region" --query KeyRotationEnabled --output text)
[[ "$rotation_enabled" == "True" ]] || { echo "runtime-key rotation is not enabled" >&2; exit 1; }
account_id=$(cut -d: -f5 <<<"$receipt_key_arn")
[[ "$receipt_key_arn" == "arn:aws:kms:${region}:${account_id}:key/${receipt_key_id}" && "$account_id" =~ ^[0-9]{12}$ ]] || {
  echo "runtime-key receipt ARN is not canonical" >&2; exit 1;
}
for mapping in "${parameter_names[@]}"; do
  parameter=${mapping#*=}
  expected_parameter_arn="arn:aws:ssm:${region}:${account_id}:parameter${parameter}"
  metadata_output=$(aws ssm describe-parameters --parameter-filters "Key=Name,Option=Equals,Values=${parameter}" --region "$region" --query 'Parameters[].[Name,Type,KeyId,ARN]' --output text)
  metadata_row_count=$(printf '%s\n' "$metadata_output" | awk 'NF { count += 1 } END { print count + 0 }')
  [[ "$metadata_row_count" -eq 1 ]] || { echo "parameter metadata did not resolve to exactly one row" >&2; exit 1; }
  IFS=$'\t' read -r metadata_name metadata_type metadata_key_id metadata_arn <<<"$metadata_output"
  [[ "$metadata_name" == "$parameter" && "$metadata_type" == "SecureString" && "$metadata_arn" == "$expected_parameter_arn" ]] || {
    echo "parameter metadata identity or type mismatch" >&2; exit 1;
  }
  metadata_key_id=$(aws kms describe-key --key-id "$metadata_key_id" --region "$region" --query KeyMetadata.KeyId --output text)
  metadata_key_arn=$(aws kms describe-key --key-id "$metadata_key_id" --region "$region" --query KeyMetadata.Arn --output text)
  [[ "$metadata_key_id" == "$receipt_key_id" && "$metadata_key_arn" == "$receipt_key_arn" ]] || {
    echo "parameter is not encrypted by the prepared runtime key" >&2; exit 1;
  }
  decrypted_parameter_arn=$(aws ssm get-parameter --name "$parameter" --with-decryption --region "$region" --query Parameter.ARN --output text)
  [[ "$decrypted_parameter_arn" == "$expected_parameter_arn" ]] || { echo "decrypted parameter identity mismatch" >&2; exit 1; }
done
echo "all runtime parameter identifiers and decrypt access prevalidated; no values displayed" >&2
