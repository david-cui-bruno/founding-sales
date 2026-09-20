#!/usr/bin/env bash
# Shared rules for every rehearsal script (specification 16.2, Appendix G 39).
#
# Sourced, never executed. Three things live here because every script needs them
# and because having one copy is what makes them true:
#
#   1. the prefix guard — nothing a rehearsal script touches may be named `fss-prod`;
#   2. dry-run mode — every script prints the plan it would run and exits 0 without a
#      credential, which is how the release workflow is exercised in ordinary CI and
#      how this lane wrote them without ever reaching AWS;
#   3. `aws()` — a wrapper that refuses to invoke the CLI at all in dry-run mode, so a
#      command added later cannot quietly escape the mode.
#
# Every script is `set -euo pipefail`. A rehearsal that half-ran is worse than one that
# stopped, because the release record would be written against a drill nobody finished.

set -euo pipefail

# The one namespace a rehearsal may create, address or destroy.
REHEARSAL_PREFIX_PATTERN='^fss-rh-[a-z0-9-]{3,18}$'
# The namespace it must never touch, in any command, in any argument.
PRODUCTION_PREFIX='fss-prod'

rehearsal_dry_run() {
  [ "${FSS_REHEARSAL_DRY_RUN:-0}" = "1" ]
}

rehearsal_log() {
  printf '%s %s\n' "[$(basename "${BASH_SOURCE[1]:-rehearsal}")]" "$*"
}

rehearsal_plan() {
  printf 'PLAN %s\n' "$*"
}

# Refuse a prefix that is not a rehearsal prefix, before anything is addressed.
rehearsal_require_prefix() {
  local prefix=${1:-}
  if [ -z "$prefix" ]; then
    echo "FAIL: a rehearsal script needs a name prefix (fss-rh-<run>)" >&2
    return 1
  fi
  if [[ ! "$prefix" =~ $REHEARSAL_PREFIX_PATTERN ]]; then
    echo "FAIL: '$prefix' is not a rehearsal prefix; it must match $REHEARSAL_PREFIX_PATTERN" >&2
    return 1
  fi
  case "$prefix" in
    "$PRODUCTION_PREFIX"*)
      echo "FAIL: '$prefix' begins with the production prefix" >&2
      return 1
      ;;
  esac
  return 0
}

# Appendix G 39, enforced in the script as well as in the IAM boundary: no argument of
# any command a rehearsal script runs may name a production resource. The IAM condition
# on `fss-rh-deploy` is the real boundary; this is the one that fails *before* the call
# is made, so a mistake shows up as a script error rather than an AccessDenied in a log.
rehearsal_refuse_production_arguments() {
  local argument
  for argument in "$@"; do
    case "$argument" in
      *"$PRODUCTION_PREFIX"*)
        echo "FAIL: a rehearsal command names a production resource: $argument" >&2
        return 1
        ;;
    esac
  done
  return 0
}

# Every AWS call in every rehearsal script goes through this.
rehearsal_aws() {
  rehearsal_refuse_production_arguments "$@"
  if rehearsal_dry_run; then
    rehearsal_plan "aws $*"
    return 0
  fi
  command aws "$@"
}

# Every Terraform call, for the same reason and with the same guard.
rehearsal_terraform() {
  rehearsal_refuse_production_arguments "$@"
  if rehearsal_dry_run; then
    rehearsal_plan "terraform $*"
    return 0
  fi
  command "${TERRAFORM:-terraform}" "$@"
}

# A report file every script writes, so the release record can name what ran.
rehearsal_report_dir() {
  echo "${FSS_REHEARSAL_REPORTS:-/tmp/fss-rehearsal}"
}

rehearsal_write_report() {
  local name=$1
  shift
  local directory
  directory="$(rehearsal_report_dir)"
  mkdir -p "$directory"
  printf '%s\n' "$*" > "$directory/$name"
  rehearsal_log "wrote $directory/$name"
}
