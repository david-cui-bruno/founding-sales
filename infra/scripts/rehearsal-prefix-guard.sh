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
#   3. the production resources that existed before the run still exist afterwards,
#      with the same identifiers — so "teardown could not address them" is measured
#      rather than asserted.
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
      rehearsal_plan "compare the production inventory with $INVENTORY"
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
      current="$(production_inventory)"
      if [ "$current" != "$(cat "$INVENTORY")" ]; then
        echo "FAIL: the production inventory changed during the rehearsal run" >&2
        diff <(cat "$INVENTORY") <(printf '%s\n' "$current") >&2 || true
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
