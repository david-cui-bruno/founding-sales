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

# The AWS CLI a rehearsal script invokes. A seam, exactly like `${TERRAFORM:-terraform}`
# below, and it exists for the same reason: the not-found branches of the teardown have
# to be exercised offline, and the only honest way to exercise "the CLI said the
# instance does not exist" is to have something say it. Production never sets it.
rehearsal_aws_command() {
  echo "${FSS_REHEARSAL_AWS_COMMAND:-aws}"
}

# Every AWS call in every rehearsal script goes through this.
rehearsal_aws() {
  # `|| return 1`, not a bare call: a refusal must be the function's answer even when
  # the caller has errexit suppressed — inside an `if`, a `&&` chain or a command
  # substitution — or the guard would print FAIL and issue the command anyway.
  rehearsal_refuse_production_arguments "$@" || return 1
  if rehearsal_dry_run; then
    rehearsal_plan "aws $*"
    return 0
  fi
  command "$(rehearsal_aws_command)" "$@"
}

# ---------------------------------------------------------------------------
# The run's own resources, read by name, and no exemption from the refusal above.
#
# Until lane g97 (25 September 2026) Appendix G 39's last clause — "rehearsal teardown
# cannot address production resources" — was measured by reading the *production*
# inventory before the run and comparing it afterwards. That read named production, so
# it needed the one exemption from `rehearsal_refuse_production_arguments` this file
# used to carry (`rehearsal_read_production_inventory`, G12f). And the comparison
# measured production, which moves for reasons of its own: on the night of 25 September
# a rehearsal failed its last step only because the operator applied production while it
# ran. `docs/greenfield/release.md` 3, item 14, has the whole paragraph.
#
# So the read is of this run's own resources now — every resource whose `Name` tag is
# the run prefix or begins `<prefix>-` — and it goes through `rehearsal_aws` like every
# other command, because it names nothing but the run. No rehearsal command names
# production any more, and `rehearsal-prefix-guard.sh <prefix> plan <file>` holds the
# printed plan to exactly that on every pull request.
#
# `get-resources` tag-filter values are exact matches and take no wildcard, so the
# filter asks for every resource that has a `Name` tag and the selection is local.

# The phrase the printed plan carries on the read's line, so the plan guard can find it.
REHEARSAL_RUN_INVENTORY_MARKER='select names beginning'

# What a dry run records in place of an inventory it never read. The `after` phase
# refuses to compare against this: the workflow's own "decide the run prefix" step runs
# the `before` phase in dry mode, and a comparison with a fabricated empty list is the
# vacuous pass the guard exists to prevent.
REHEARSAL_DRY_RUN_INVENTORY='["dry-run: no inventory was read"]'

# Print a sorted JSON array of the ARNs of every resource named for this run.
#
#   rehearsal_read_run_inventory <fss-rh-run>
#
# Sorted because the API promises no order and an unstable order would fail the
# before/after comparison for no reason.
rehearsal_read_run_inventory() {
  local prefix=${1:-}
  rehearsal_require_prefix "$prefix" || return 1
  rehearsal_refuse_production_arguments "$prefix" || return 1
  # Dry mode prints the line and reads nothing, like every other rehearsal command: the
  # caller writes `REHEARSAL_DRY_RUN_INVENTORY` where the answer would have gone.
  if rehearsal_dry_run; then
    rehearsal_plan "aws resourcegroupstaggingapi get-resources --tag-filters Key=Name --output json" \
      "| $REHEARSAL_RUN_INVENTORY_MARKER $prefix"
    return 0
  fi
  rehearsal_aws resourcegroupstaggingapi get-resources \
    --tag-filters "Key=Name" \
    --query 'ResourceTagMappingList[].{arn:ResourceARN,name:Tags[?Key==`Name`]|[0].Value}' \
    --output json | rehearsal_select_run_names "$prefix"
}

# The local half of the read: every row whose Name is the prefix or begins `<prefix>-`,
# sorted, as a JSON array. `fss-rh-2026092506` is not `fss-rh-202609250600`'s, so a bare
# string prefix is not enough. An empty result is an empty array, never an error.
rehearsal_select_run_names() {
  FSS_RUN_PREFIX="${1:?a run prefix}" python3 -c '
import json, os, sys

prefix = os.environ["FSS_RUN_PREFIX"]
rows = json.load(sys.stdin) or []
arns = sorted(
    row["arn"]
    for row in rows
    if isinstance(row.get("name"), str) and row.get("arn")
    and (row["name"] == prefix or row["name"].startswith(prefix + "-"))
)
json.dump(arns, sys.stdout, indent=2)
sys.stdout.write("\n")
'
}

# A cleanup step that finds nothing to clean is done, not failed.
#
#   rehearsal_tolerate_absent <what> <command> [argument...]
#
# The first credentialed rehearsal created nothing — the inventory read above refused
# before the apply — and the teardown then failed with `DBInstance
# fss-rh-…-pg-restored not found`, which stopped it before it reached the bucket and
# the root. A teardown that cannot run after a failed creation is a teardown that runs
# least often exactly when it matters most.
#
# Absence is recognised by the AWS error *code*, in parentheses, as the CLI prints it.
# Nothing else is tolerated: an `AccessDenied`, a throttle or a timeout still fails,
# because "the thing is gone" and "I was not allowed to look" must not be the same
# outcome.
REHEARSAL_ABSENCE_ERROR_CODES='DBInstanceNotFound DBInstanceNotFoundFault DBSnapshotNotFound DBSnapshotNotFoundFault NoSuchBucket ResourceNotFoundException ClusterNotFoundException ServiceNotFoundException NoSuchEntity'

rehearsal_tolerate_absent() {
  local what=$1
  shift
  local output status code
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    if [ -n "$output" ]; then printf '%s\n' "$output"; fi
    return 0
  fi
  # The verdict goes to stderr, never to stdout: callers capture the command's own
  # output in a command substitution, and a log line landing in a JSON document is the
  # sort of thing that turns a tolerated absence into an unreadable failure.
  for code in $REHEARSAL_ABSENCE_ERROR_CODES; do
    case "$output" in
      *"($code)"*)
        rehearsal_log "$what: already absent ($code), so this step is done" >&2
        return 0
        ;;
    esac
  done
  printf '%s\n' "$output" >&2
  echo "FAIL: $what did not fail because the resource was absent; it failed for another reason" >&2
  return 1
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

# The account of the verified session, set by rehearsal_require_deployment_session. The
# journal module names its bucket `<prefix>-suppression-journal-<account>`, so a
# teardown that has to name that bucket reads the account from here rather than
# asking STS a second time. Empty until the check has passed; empty in a dry run.
REHEARSAL_SESSION_ACCOUNT=''

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

  REHEARSAL_SESSION_ACCOUNT="${identity#arn:*:sts::}"
  REHEARSAL_SESSION_ACCOUNT="${REHEARSAL_SESSION_ACCOUNT%%:*}"
  rehearsal_log "the session is an assumed-role session of $role, so ${REHEARSAL_NO_ASSUME_VAR} is safe"
  return 0
}

# Every Terraform call, for the same reason and with the same guard.
rehearsal_terraform() {
  rehearsal_refuse_production_arguments "$@" || return 1
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
