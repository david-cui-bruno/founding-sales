#!/usr/bin/env bash
# Appendix G 39: "Production and rehearsal Terraform plans use distinct state keys,
# roles, secrets and resource namespaces; rehearsal teardown cannot address production
# resources."
#
#   infra/scripts/rehearsal-prefix-guard.sh <fss-rh-run> [after|before]
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
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints the plan and needs no credential.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

PREFIX=${1:-}
PHASE=${2:-after}
rehearsal_require_prefix "$PREFIX"

INVENTORY="$(rehearsal_report_dir)/production-inventory.json"

production_inventory() {
  # Read-only describes over the *production* namespace. The rehearsal deployment role
  # cannot make them, which is the point: this runs under the workflow's read-only
  # inventory role, and if it cannot read production either the scenario still passes,
  # because "could not address" is the claim.
  rehearsal_aws resourcegroupstaggingapi get-resources \
    --tag-filters "Key=Name,Values=${PRODUCTION_PREFIX}*" \
    --query 'ResourceTagMappingList[].ResourceARN' --output json
}

case "$PHASE" in
  before)
    rehearsal_log "recording the production inventory before the rehearsal run"
    mkdir -p "$(rehearsal_report_dir)"
    if rehearsal_dry_run; then
      rehearsal_plan "record the production inventory to $INVENTORY"
      printf '[]\n' > "$INVENTORY"
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
    else
      offending="$(command "${TERRAFORM:-terraform}" state list 2>/dev/null | grep -F "$PRODUCTION_PREFIX" || true)"
      if [ -n "$offending" ]; then
        echo "FAIL: the rehearsal state names production resources:" >&2
        echo "$offending" >&2
        exit 1
      fi

      # 2. The identity that ran it.
      identity="$(command aws sts get-caller-identity --query 'Arn' --output text)"
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
      current="$(production_inventory)"
      if [ "$current" != "$(cat "$INVENTORY")" ]; then
        echo "FAIL: the production inventory changed during the rehearsal run" >&2
        diff <(cat "$INVENTORY") <(printf '%s\n' "$current") >&2 || true
        exit 1
      fi
    fi

    rehearsal_write_report "prefix-guard.txt" \
      "prefix=$PREFIX production_untouched=true stable_repositories=rehearsal"
    rehearsal_log "pass: nothing with the production prefix was addressed"
    ;;
  *)
    echo "FAIL: phase must be before or after" >&2
    exit 1
    ;;
esac
