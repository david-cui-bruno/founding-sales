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
# The one exemption from the refusal above, and the shape that keeps it one.
#
# Appendix G 39's last clause — "rehearsal teardown cannot address production
# resources" — is *measured* rather than asserted: `rehearsal-prefix-guard.sh` records
# the production inventory before the run and compares it afterwards
# (`docs/greenfield/release.md` 3, step 3). A comparison needs a read, and a read of
# production names production. The guard above refused it, and that is exactly how far
# the first credentialed rehearsal got (Actions run 35548888865):
#
#   FAIL: a rehearsal command names a production resource: Key=Name,Values=fss-prod*
#
# The exemption is structural, not an allow-listed string:
#
#   1. one function may make the read, `rehearsal_read_production_inventory`;
#   2. it checks the service and operation it is about to run against a list of
#      read-only ones, so the constraint is a test over a value rather than a property
#      of a literal nobody varies — a mutating verb is refused even from in here;
#   3. it builds the production filter itself and takes no further arguments, so no
#      caller can push a production name through it;
#   4. `rehearsal_aws`, `rehearsal_terraform` and `rehearsal_refuse_production_arguments`
#      are untouched: every other command naming `fss-prod` is still refused.
#
# The plan the dry run prints carries `REHEARSAL_INVENTORY_MARKER` on this one line, and
# `rehearsal-prefix-guard.sh <prefix> plan <file>` re-runs the same refusal over that
# printed plan — so a rehearsal that would refuse itself is red on the pull request
# rather than on the next credentialed run.

# Service and operation pairs the production-inventory read may issue. Read-only by
# name. Paging is the CLI's (`get-resources` auto-paginates), so no second verb is
# needed; if one ever is, it is added here and nowhere else.
REHEARSAL_INVENTORY_READ_ONLY='resourcegroupstaggingapi:get-resources'

# The token that marks the one exempt line of a printed plan.
REHEARSAL_INVENTORY_MARKER='exempt-read-only-production-inventory'

# What a dry run records in place of an inventory it never read. The `after` phase
# refuses to compare a real inventory against this: comparing today's production with a
# fabricated empty list is the vacuous pass this scenario exists to prevent, and the
# workflow's own "decide the run prefix" step runs the `before` phase in dry mode.
REHEARSAL_DRY_RUN_INVENTORY='["dry-run: no production inventory was read"]'

# Read the production inventory. The only rehearsal command that may name production.
#
#   rehearsal_read_production_inventory <service> <operation>
#
# Prints a sorted JSON array of the ARNs of every resource whose `Name` tag begins with
# the production prefix. Sorted because the API does not promise an order and an
# unstable order would fail the before/after comparison for no reason; selected locally
# because `get-resources` tag-filter values are exact matches and do not accept the
# `fss-prod*` wildcard the first version passed — which would have made the comparison
# a comparison of two empty lists.
rehearsal_read_production_inventory() {
  local service=${1:-} operation=${2:-} pair allowed matched=0
  pair="$service:$operation"
  for allowed in $REHEARSAL_INVENTORY_READ_ONLY; do
    if [ "$pair" = "$allowed" ]; then matched=1; fi
  done
  if [ "$matched" -ne 1 ]; then
    echo "FAIL: the production inventory read may only issue [$REHEARSAL_INVENTORY_READ_ONLY], not '$pair'" >&2
    return 1
  fi
  shift 2
  if [ "$#" -ne 0 ]; then
    echo "FAIL: the production inventory read takes no further arguments; it builds its own filter: $*" >&2
    return 1
  fi

  # Dry mode prints the line and reads nothing, like every other rehearsal command:
  # the caller writes `REHEARSAL_DRY_RUN_INVENTORY` where the answer would have gone,
  # so the plan on stdout stays a plan and the file stays a file.
  if rehearsal_dry_run; then
    rehearsal_plan "aws $service $operation --tag-filters Key=Name --output json" \
      "| select names beginning ${PRODUCTION_PREFIX} # $REHEARSAL_INVENTORY_MARKER"
    return 0
  fi

  command "$(rehearsal_aws_command)" "$service" "$operation" \
    --tag-filters "Key=Name" \
    --query 'ResourceTagMappingList[].{arn:ResourceARN,name:Tags[?Key==`Name`]|[0].Value}' \
    --output json | rehearsal_select_production_names
}

# The local half of the read: everything whose Name tag begins with the production
# prefix, sorted, as a JSON array. An empty result is an empty array, never an error —
# an account with no production resources yet is a fact, not a failure.
rehearsal_select_production_names() {
  FSS_PRODUCTION_PREFIX="$PRODUCTION_PREFIX" python3 -c '
import json, os, sys

prefix = os.environ["FSS_PRODUCTION_PREFIX"]
rows = json.load(sys.stdin) or []
arns = sorted(
    row["arn"]
    for row in rows
    if isinstance(row.get("name"), str) and row["name"].startswith(prefix) and row.get("arn")
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
