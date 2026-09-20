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

# The two rehearsal-namespace resources that carry no run identifier.
#
# `infra/roots/rehearsal-registry` owns them and is applied once: the images
# have to be in ECR before a run exists, and the release workflow's environment
# secrets name them without a run. They are therefore the only `fss-rh-` names
# a guard will see that do not contain the run it is checking, and they are
# rehearsal resources — never production ones — which is what
# `rehearsal_classify_name` exists to say out loud.
REHEARSAL_STABLE_NAMES='fss-rh-api fss-rh-worker'

# Print `production`, `rehearsal-run`, `rehearsal-stable` or `foreign` for a
# resource name, and return non-zero for anything a rehearsal may not address.
#
#   rehearsal_classify_name <run prefix> <name>
rehearsal_classify_name() {
  local prefix=$1 name=$2 stable
  case "$name" in
    "$PRODUCTION_PREFIX"*)
      echo "production"
      return 1
      ;;
  esac
  for stable in $REHEARSAL_STABLE_NAMES; do
    if [ "$name" = "$stable" ]; then
      echo "rehearsal-stable"
      return 0
    fi
  done
  case "$name" in
    "$prefix"*)
      echo "rehearsal-run"
      return 0
      ;;
  esac
  echo "foreign"
  return 1
}

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

# The flag every rehearsal Terraform command carries, and the reason it is safe.
#
# `infra/roots/rehearsal` and `infra/roots/rehearsal-registry` assume
# `deployment_role_name` by default, because a root that acts as whatever credential
# is lying around is a root nobody can reason about. A workflow session has already
# assumed `fss-rh-deploy` through GitHub OIDC, and a role cannot be assumed from
# itself unless it trusts itself — which `fss-rh-deploy` does not and must not
# (Appendix G 39). So CI turns the assumption off, and the only thing standing between
# that flag and "run rehearsal Terraform as some other principal" is the check below.
REHEARSAL_NO_ASSUME_VAR='-var=assume_deployment_role=false'

# Refuse to continue unless this session *is* an assumed-role session of the named
# rehearsal role.
#
#   rehearsal_require_deployment_session fss-rh-deploy
#
# `aws sts get-caller-identity --query Arn` is printed: an ARN is a public identifier
# and naming the principal is the whole point. The shape matters as much as the name —
# `arn:aws:sts::<account>:assumed-role/<role>/<session>` is a session that assumed the
# role, while `arn:aws:iam::<account>:user/<name>` is a user who did not — so an ARN
# that merely contains the role name is refused.
#
# Tests and operators can supply the ARN with `FSS_REHEARSAL_CALLER_IDENTITY` instead
# of calling AWS, which is how the release suite exercises the refusals offline.
rehearsal_require_deployment_session() {
  local role=${1:-} identity pattern
  if [ -z "$role" ]; then
    echo "FAIL: which role the session must be is not optional" >&2
    return 1
  fi
  # This check exists for the rehearsal roots. It may never be pointed at production:
  # the production applies are local and the provider does the assuming there.
  case "$role" in
    fss-rh-*) : ;;
    *)
      echo "FAIL: '$role' is not a rehearsal deployment role; this check is for the fss-rh- namespace" >&2
      return 1
      ;;
  esac

  # Set-but-empty is a judgement too, and it must not become a call: a test asking
  # "what does this do with no identity at all?" has to be answered offline.
  if [ "${FSS_REHEARSAL_CALLER_IDENTITY+set}" = "set" ]; then
    identity=${FSS_REHEARSAL_CALLER_IDENTITY}
  elif rehearsal_dry_run; then
    rehearsal_plan "aws sts get-caller-identity --query Arn --output text"
    rehearsal_plan "refuse unless it reads arn:aws:sts::<account>:assumed-role/$role/<session>"
    return 0
  else
    identity="$(command aws sts get-caller-identity --query Arn --output text)"
  fi

  echo "caller identity: ${identity:-<none>}"

  pattern="^arn:aws[a-z0-9-]*:sts::[0-9]{12}:assumed-role/${role}/.+$"
  if [[ ! "$identity" =~ $pattern ]]; then
    echo "FAIL: this session is ${identity:-<none>}, which is not an assumed-role session of $role." >&2
    echo "      Rehearsal Terraform runs with ${REHEARSAL_NO_ASSUME_VAR}, so whatever this session is" >&2
    echo "      is what the apply would act as. Refusing." >&2
    return 1
  fi

  rehearsal_log "the session is an assumed-role session of $role, so ${REHEARSAL_NO_ASSUME_VAR} is safe"
  return 0
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
