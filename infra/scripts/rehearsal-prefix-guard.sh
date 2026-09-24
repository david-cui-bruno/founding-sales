#!/usr/bin/env bash
# Appendix G 39: "Production and rehearsal Terraform plans use distinct state keys,
# roles, secrets and resource namespaces; rehearsal teardown cannot address production
# resources."
#
#   infra/scripts/rehearsal-prefix-guard.sh <fss-rh-run> [after|before]
#   infra/scripts/rehearsal-prefix-guard.sh <fss-rh-run> plan <printed plan file>
#
# The offline half of this scenario is `infra/roots/*/tests/isolation.tftest.hcl`,
# which pins the state-key prefixes and the name-prefix refusals against mocked
# providers. That proves the *plans* differ. It cannot prove the last clause, which is
# about what a real teardown could reach.
#
# This is the other half, and it is deliberately an assertion about absence: after the
# rehearsal run has been destroyed, nothing carrying the production prefix may have
# been touched. It is checked three ways, because one way is a coincidence:
#
#   1. every resource the rehearsal state ever held is named `fss-rh-<run>`;
#   2. the deployment role the run assumed is `fss-rh-deploy`, not `fss-prod-deploy`;
#   3. the durable production resources that existed before the run still exist
#      afterwards, with the same identifiers — so "teardown could not address them" is
#      measured rather than asserted. Durable means everything but ECS tasks, which ECS
#      forgets on its own (`durable_inventory`, below).
#
# `before` records the production inventory; `after` compares. The comparison is the
# test; recording alone proves nothing, and the script says so if `after` is run with
# no `before` to compare against.
#
# The inventory read is the one rehearsal command that names production on purpose, and
# the shared guard refused it on the first credentialed run (Actions 35548888865). It is
# now issued through `rehearsal_read_production_inventory`, the single exempt caller;
# see the long comment in `rehearsal-common.sh` for what keeps the exemption to one
# read-only command.
#
# `plan` is the third phase and the one that runs on every pull request: it re-applies
# the production-name refusal to the plan the dry run printed, so a rehearsal whose own
# commands would be refused is red before anybody spends a credential on it.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints the plan and needs no credential.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

PREFIX=${1:-}
PHASE=${2:-after}
rehearsal_require_prefix "$PREFIX"

INVENTORY="$(rehearsal_report_dir)/production-inventory.json"

production_inventory() {
  # Read-only describes over the *production* namespace, through the single exempt
  # caller. The rehearsal deployment role may not make them, which is the point: this
  # runs under the workflow's read-only inventory role, and if it cannot read
  # production either the scenario still passes, because "could not address" is the
  # claim — but then the comparison is between two errors, so the read is a refusal
  # rather than an empty list when it fails.
  rehearsal_read_production_inventory resourcegroupstaggingapi get-resources
}

# The inventory minus what ECS forgets on its own.
#
#   durable_inventory <which side> < inventory.json
#
# The tagging API lists ECS *tasks*, because a service's tasks carry its propagated tags,
# and a task is not a durable resource: a stopped one stays visible for about an hour and
# then ECS forgets it. Run 35962272085 (24 September 2026, prefix fss-rh-202609240558)
# failed this comparison with exactly twelve deleted lines, every one
# `arn:aws:ecs:us-east-1:…:task/fss-prod-cluster/<id>` — the old service tasks and the
# one-off migrate, users, verify and bootstrap tasks of the production redeploy at
# 05:50–05:57Z, recorded at 05:59Z while ECS still showed them and aged out by 07:10Z.
# Production had not moved: both services stayed stable on revision 4 throughout.
#
# So the comparison is between durable resources, and this is the one place that says
# what durable means: every ARN except one whose service is `ecs` and whose resource
# part begins `task/`. Parsed rather than matched as a substring, so
# `task-definition/fss-prod-api:5` is kept — a new task-definition revision is a
# production touch and must still fail the guard — and so are the cluster, the
# services, the log groups, the alarms, the buckets and the roles. A task the rehearsal
# itself launched into production is not measured here; that direction is refused per
# launch by `release_refuse_foreign_arguments` in `release-common.sh` (Appendix G 39,
# the symmetric refusal) and by the identity assertion in step 2.
#
# Applied to **both** sides at comparison time, not only to the read, so a `before`
# file recorded by an older guard — one that kept its tasks — compares correctly too.
# The recorded file itself stays the raw read: it is the evidence of what existed.
durable_inventory() {
  FSS_INVENTORY_SIDE="${1:-inventory}" python3 -c '
import json, os, sys

side = os.environ["FSS_INVENTORY_SIDE"]
try:
    arns = json.load(sys.stdin)
except ValueError as error:
    sys.stderr.write("FAIL: the production inventory %s is not JSON: %s\n" % (side, error))
    sys.exit(1)
if not isinstance(arns, list):
    sys.stderr.write("FAIL: the production inventory %s is not a list of ARNs\n" % side)
    sys.exit(1)

def is_ecs_task(arn):
    parts = arn.split(":", 5) if isinstance(arn, str) else []
    return len(parts) == 6 and parts[0] == "arn" and parts[2] == "ecs" and parts[5].startswith("task/")

durable = [arn for arn in arns if not is_ecs_task(arn)]
set_aside = len(arns) - len(durable)
if set_aside:
    sys.stderr.write(
        "the production inventory %s: %d ECS task ARN(s) set aside, because ECS forgets a stopped task\n"
        % (side, set_aside)
    )
json.dump(durable, sys.stdout, indent=2)
sys.stdout.write("\n")
'
}

case "$PHASE" in
  before)
    rehearsal_log "recording the production inventory before the rehearsal run"
    mkdir -p "$(rehearsal_report_dir)"
    # Dry mode records the sentinel rather than `[]`: the workflow runs this phase in
    # dry mode when it decides the run prefix, and an `after` that compared real
    # production against a fabricated empty list would pass by construction.
    if rehearsal_dry_run; then
      production_inventory
      printf '%s\n' "$REHEARSAL_DRY_RUN_INVENTORY" > "$INVENTORY"
    else
      production_inventory > "$INVENTORY"
    fi
    rehearsal_log "recorded $(wc -l < "$INVENTORY" | tr -d ' ') lines"
    ;;
  after)
    rehearsal_log "asserting the rehearsal run touched nothing with the production prefix"

    # 0. The names a rehearsal may address, classified rather than assumed.
    #
    #    Two rehearsal resources carry no run identifier: the stable ECR
    #    repositories `fss-rh-api` and `fss-rh-worker`, which exist before the
    #    run does because the images are pushed before the run does. They are
    #    rehearsal-namespace resources and a guard that treated an `fss-rh-`
    #    name without the run in it as "not mine, therefore production's"
    #    would fail this scenario for the wrong reason. This runs in dry mode
    #    too, so every pull request exercises both branches.
    for expected in "${PREFIX}-api" $REHEARSAL_STABLE_NAMES; do
      verdict="$(rehearsal_classify_name "$PREFIX" "$expected")" || {
        echo "FAIL: $expected classified as $verdict; it is a rehearsal-namespace resource" >&2
        exit 1
      }
      rehearsal_log "$expected: $verdict"
    done
    if rehearsal_classify_name "$PREFIX" "${PRODUCTION_PREFIX}-api" >/dev/null 2>&1; then
      echo "FAIL: the name classifier accepted a production resource" >&2
      exit 1
    fi
    if rehearsal_classify_name "$PREFIX" "fss-rh-someone-elses-run" >/dev/null 2>&1; then
      echo "FAIL: the name classifier accepted another run's resource" >&2
      exit 1
    fi

    # 1. Every resource the state held is a rehearsal resource.
    if rehearsal_dry_run; then
      rehearsal_plan "terraform state list | grep -v '$PREFIX' -> expect empty"
      rehearsal_plan "aws sts get-caller-identity -> expect an fss-rh- role"
      rehearsal_plan "compare the durable production inventory (ECS tasks set aside, both sides) with $INVENTORY"
      production_inventory
    else
      # A state that cannot be listed is the shape a run that created nothing takes:
      # the creation step never ran, so the root was never initialised. That is a pass
      # for this clause — no state, no production resource in it — but it is said out
      # loud rather than swallowed by a `|| true`, because "the state holds nothing
      # named fss-prod" and "I could not read the state" are different facts.
      set +e
      state="$(command "${TERRAFORM:-terraform}" state list 2>&1)"
      state_status=$?
      set -e
      if [ "$state_status" -eq 0 ]; then
        state_read=true
        offending="$(printf '%s\n' "$state" | grep -F "$PRODUCTION_PREFIX" || true)"
      else
        state_read=false
        offending=''
        rehearsal_log "the rehearsal state could not be listed, which is what a run that created nothing looks like:"
        printf '%s\n' "$state" | head -3 | sed 's/^/  /'
      fi
      if [ -n "$offending" ]; then
        echo "FAIL: the rehearsal state names production resources:" >&2
        echo "$offending" >&2
        exit 1
      fi

      # 2. The identity that ran it. Through the same seam as every other call, so
      #    the release suite can drive this branch without a credential.
      identity="${FSS_REHEARSAL_CALLER_IDENTITY-$(command "$(rehearsal_aws_command)" sts get-caller-identity --query 'Arn' --output text)}"
      case "$identity" in
        *fss-rh-*) : ;;
        *)
          echo "FAIL: the rehearsal ran as $identity, which is not an fss-rh- role" >&2
          exit 1
          ;;
      esac

      # 3. Production is exactly as it was. A missing `before` is a failure, not a
      #    skip: a comparison with nothing is the vacuous pass this script exists to
      #    avoid.
      if [ ! -f "$INVENTORY" ]; then
        echo "FAIL: no production inventory was recorded before the run, so nothing can be compared" >&2
        exit 1
      fi
      # The workflow runs the `before` phase twice: once in dry mode, to validate the
      # prefix it just decided, and once for real. If only the dry one ran, the file
      # holds the sentinel, and comparing production against it would be a pass nobody
      # earned.
      if grep -qF 'dry-run: no production inventory was read' "$INVENTORY"; then
        echo "FAIL: the only inventory recorded was a dry run's, so there is nothing to compare against" >&2
        exit 1
      fi
      # Durable resources only, on both sides (`durable_inventory` above says why).
      recorded="$(durable_inventory 'recorded before the run' < "$INVENTORY")"
      current="$(production_inventory | durable_inventory 'read now')"
      if [ "$current" != "$recorded" ]; then
        echo "FAIL: the production inventory changed during the rehearsal run" >&2
        diff <(printf '%s\n' "$recorded") <(printf '%s\n' "$current") >&2 || true
        exit 1
      fi
    fi

    rehearsal_write_report "prefix-guard.txt" \
      "prefix=$PREFIX production_untouched=true stable_repositories=rehearsal state_read=${state_read:-dry-run}"
    rehearsal_log "pass: nothing with the production prefix was addressed"
    ;;
  plan)
    # The same refusal, applied to the plan the credential-free dry run printed.
    #
    # `rehearsal_refuse_production_arguments` fails at the moment a command is issued,
    # which means a command nothing on a pull request issues — the inventory read, or
    # anything a later edit adds to a real-only branch — is first judged on a
    # credentialed run. That is how the first rehearsal refused itself. So the plan is
    # re-read here: every printed command that names production must be the one exempt
    # read, and the exempt read must be present, because a plan that quietly stopped
    # reading the inventory would pass a scan for the absence of a string.
    PLAN_FILE=${3:-}
    if [ -z "$PLAN_FILE" ] || [ ! -f "$PLAN_FILE" ]; then
      echo "FAIL: the plan phase needs the file the dry run printed: ...prefix-guard.sh $PREFIX plan <file>" >&2
      exit 1
    fi

    exempt=0
    offending=0
    while IFS= read -r line; do
      case "$line" in
        *"$PRODUCTION_PREFIX"*) : ;;
        *) continue ;;
      esac
      case "$line" in
        *"$REHEARSAL_INVENTORY_MARKER"*)
          # Marked, so it claims the exemption. It has to earn it: the one read-only
          # operation, and no mutating verb anywhere on the line.
          case "$line" in
            *"resourcegroupstaggingapi get-resources"*) : ;;
            *)
              echo "FAIL: a plan line claims the inventory exemption without being the inventory read: $line" >&2
              offending=$((offending + 1))
              continue
              ;;
          esac
          for verb in create delete destroy put update modify remove restore terminate write set-; do
            case "$line" in
              *" $verb"*|*"-$verb"*)
                echo "FAIL: the exempt inventory read names a mutating verb ('$verb'): $line" >&2
                offending=$((offending + 1))
                continue 2
                ;;
            esac
          done
          exempt=$((exempt + 1))
          rehearsal_log "exempt: $line"
          ;;
        *)
          echo "FAIL: a rehearsal command names a production resource: $line" >&2
          offending=$((offending + 1))
          ;;
      esac
    done < "$PLAN_FILE"

    if [ "$offending" -gt 0 ]; then
      echo "FAIL: $offending planned command(s) would be refused by the rehearsal's own guard" >&2
      exit 1
    fi
    if [ "$exempt" -lt 1 ]; then
      echo "FAIL: the plan contains no production-inventory read, so 'teardown could not address" >&2
      echo "      production' would be asserted rather than measured" >&2
      exit 1
    fi
    rehearsal_log "pass: $exempt exempt inventory read(s), no other planned command names production"
    ;;
  *)
    echo "FAIL: phase must be before, after or plan" >&2
    exit 1
    ;;
esac
