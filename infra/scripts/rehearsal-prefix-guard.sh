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
# about what a real run could reach.
#
# This is the other half, and it runs after the teardown on every run. It checks:
#
#   1. every resource the rehearsal state ever held is named `fss-rh-<run>`;
#   2. the deployment role the run assumed is `fss-rh-deploy`, not `fss-prod-deploy` —
#      and `fss-rh-deploy`'s policy cannot address `fss-prod*` at all;
#   3. the run's own resources — everything whose `Name` tag is the run prefix or begins
#      `<prefix>-` — are compared against what stood before creation: every durable one
#      the run created is gone. Durable means everything but what AWS keeps listing
#      after it accepted a deletion (`durable_inventory`, below).
#
# ## Why it no longer compares production (lane g97, 25 September 2026)
#
# Until g97, step 3 read the *production* inventory before the run and compared it
# afterwards, so that "teardown could not address production" was a diff. The diff was
# of a thing that moves for reasons of its own. It had already been taught that ECS
# forgets a stopped task (run 35962272085) and that a replaced task takes its network
# interface with it (run 36032732128); on the night of 25 September it failed a rehearsal
# only because the operator applied production while the rehearsal ran. A comparison
# that fails whenever production is legitimately changed measures the operator's diary.
# What the run itself touches is what carries its own prefix, and that is what is
# compared now. That nothing production's was addressed rests on the three things that
# made it true before as well: no command a rehearsal issues names production (the plan
# phase below holds the printed plan to that, and `rehearsal_refuse_production_arguments`
# refuses at the moment of the call), the session is `fss-rh-deploy`, and that role's
# policy is scoped to `fss-rh-*`. The read is no longer an exemption from the refusal:
# it names nothing but the run.
#
# `before` records the run's own resources, before anything is created — `[]` for a
# fresh run, the orphan's resources for a `teardown` run. `after` compares. A missing
# `before` is a failure, not a skip.
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

INVENTORY="$(rehearsal_report_dir)/run-inventory.json"

# The tagging API lags a deletion it has accepted, so a leftover is read again before
# it is called one. Seams for the offline checks, which set the wait to zero.
SETTLE_READS=${FSS_REHEARSAL_SETTLE_READS:-5}
SETTLE_SECONDS=${FSS_REHEARSAL_SETTLE_SECONDS:-60}

# The inventory minus what AWS keeps listing after it accepted a deletion.
#
#   durable_inventory <which side> < inventory.json
#
# The run's own resources, after its teardown, still show up in the tagging API in five
# shapes that are not leftovers:
#
#   * every `ecs` ARN — a stopped task stays visible for about an hour (run 35962272085
#     saw twelve), a deleted service or cluster is INACTIVE for a while, and a
#     deregistered task-definition revision is INACTIVE for good. None of them runs or
#     bills;
#   * an `ec2` ARN whose resource part begins `network-interface/` — a Fargate task's
#     interface carries its propagated tags and goes with the task (run 36032732128);
#   * an `ec2` ARN whose resource part begins `security-group/` or
#     `security-group-rule/` — run 36209569741 (26 September 2026) found one group and
#     eight rules still listed that `describe-security-groups` answered
#     `InvalidGroup.NotFound` for. Setting them aside measures nothing less: every group
#     the run creates is in the run's own VPC, a VPC cannot be deleted while a group of
#     its own is left in it, and a rule cannot outlive its group, so a group that really
#     stayed leaves the VPC behind with it, and the VPC is compared;
#   * a `kms` ARN whose resource part begins `key/` — a key cannot be deleted at once,
#     only scheduled for deletion after its window;
#   * an `rds` ARN whose resource part begins `auto-backup:` — a production database
#     keeps its automated backups for their retention period when it is deleted. A
#     rehearsal database no longer does (the rehearsal root sets
#     `database_delete_automated_backups = true`), and a retained backup that did stay
#     is still caught by its snapshots, `snapshot:rds:<prefix>-pg-<date>`, which are
#     compared: that is what run 36209569741 found.
#
# Parsed rather than matched as a substring, and each class is counted in the log. Every
# other resource is compared: the database instance and its snapshots, automated ones
# included, the buckets, the load balancer, the log groups, the alarms, the secrets, the
# VPC and the subnets.
durable_inventory() {
  FSS_INVENTORY_SIDE="${1:-inventory}" python3 -c '
import json, os, sys

side = os.environ["FSS_INVENTORY_SIDE"]
try:
    arns = json.load(sys.stdin)
except ValueError as error:
    sys.stderr.write("FAIL: the run inventory %s is not JSON: %s\n" % (side, error))
    sys.exit(1)
if not isinstance(arns, list):
    sys.stderr.write("FAIL: the run inventory %s is not a list of ARNs\n" % side)
    sys.exit(1)

def arn_parts(arn):
    # arn:partition:service:region:account:resource, where the resource may hold colons.
    parts = arn.split(":", 5) if isinstance(arn, str) else []
    return parts if len(parts) == 6 and parts[0] == "arn" else None

def lingering(arn):
    parts = arn_parts(arn)
    if parts is None:
        return None
    service, resource = parts[2], parts[5]
    if service == "ecs":
        return "ECS"
    if service == "ec2" and resource.startswith("network-interface/"):
        return "network interface"
    if service == "ec2" and resource.startswith("security-group/"):
        return "security group"
    if service == "ec2" and resource.startswith("security-group-rule/"):
        return "security group rule"
    if service == "kms" and resource.startswith("key/"):
        return "KMS key"
    if service == "rds" and resource.startswith("auto-backup:"):
        return "retained automated backup"
    return None

counts = {}
durable = []
for arn in arns:
    kind = lingering(arn)
    if kind is None:
        durable.append(arn)
    else:
        counts[kind] = counts.get(kind, 0) + 1
if counts:
    sys.stderr.write(
        "the run inventory %s: set aside %s, because AWS keeps listing them after it accepted the deletion\n"
        % (side, ", ".join("%d %s ARN(s)" % (counts[kind], kind) for kind in sorted(counts)))
    )
json.dump(sorted(durable), sys.stdout, indent=2)
sys.stdout.write("\n")
'
}

# Durable ARNs in the second list that the first does not hold, one per line.
left_behind() {
  FSS_RECORDED="$1" FSS_CURRENT="$2" python3 -c '
import json, os
recorded = set(json.loads(os.environ["FSS_RECORDED"]))
for arn in json.loads(os.environ["FSS_CURRENT"]):
    if arn not in recorded:
        print(arn)
'
}

case "$PHASE" in
  before)
    rehearsal_log "recording the resources named for ${PREFIX} before anything is created"
    mkdir -p "$(rehearsal_report_dir)"
    # Dry mode records the sentinel rather than `[]`: the workflow runs this phase in
    # dry mode when it decides the run prefix, and an `after` that compared against a
    # fabricated empty list would pass by construction.
    if rehearsal_dry_run; then
      rehearsal_read_run_inventory "$PREFIX"
      printf '%s\n' "$REHEARSAL_DRY_RUN_INVENTORY" > "$INVENTORY"
    else
      rehearsal_read_run_inventory "$PREFIX" > "$INVENTORY"
    fi
    rehearsal_log "recorded $(wc -l < "$INVENTORY" | tr -d ' ') lines"
    ;;
  after)
    rehearsal_log "asserting the rehearsal run touched nothing with the production prefix and left nothing of its own"

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
      rehearsal_plan "compare the durable resources named for $PREFIX (ECS, network interfaces, security groups and their rules, KMS keys and retained backups set aside) with $INVENTORY"
      rehearsal_read_run_inventory "$PREFIX"
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

      # 3. The run's own resources, against what stood before creation. A missing
      #    `before` is a failure, not a skip: a comparison with nothing is the vacuous
      #    pass this script exists to avoid.
      if [ ! -f "$INVENTORY" ]; then
        echo "FAIL: nothing was recorded before the run was created, so nothing can be compared" >&2
        exit 1
      fi
      # The workflow runs the `before` phase twice: once in dry mode, to validate the
      # prefix it just decided, and once for real. If only the dry one ran, the file
      # holds the sentinel, and comparing against it would be a pass nobody earned.
      if grep -qF 'dry-run: no inventory was read' "$INVENTORY"; then
        echo "FAIL: the only inventory recorded was a dry run's, so there is nothing to compare against" >&2
        exit 1
      fi
      recorded="$(durable_inventory 'recorded before the run' < "$INVENTORY")"
      reads=0
      while :; do
        reads=$((reads + 1))
        current="$(rehearsal_read_run_inventory "$PREFIX" | durable_inventory 'read now')"
        left="$(left_behind "$recorded" "$current")"
        [ -n "$left" ] || break
        if [ "$reads" -gt "$SETTLE_READS" ]; then
          echo "FAIL: the rehearsal run left resources named for ${PREFIX} behind after its teardown:" >&2
          printf '%s\n' "$left" >&2
          exit 1
        fi
        rehearsal_log "$(printf '%s\n' "$left" | wc -l | tr -d ' ') resource(s) named for ${PREFIX} still listed; reading again in ${SETTLE_SECONDS}s (${reads} of $((SETTLE_READS + 1)))"
        sleep "$SETTLE_SECONDS"
      done
    fi

    rehearsal_write_report "prefix-guard.txt" \
      "prefix=$PREFIX production_untouched=true run_resources_left=0 stable_repositories=rehearsal state_read=${state_read:-dry-run}"
    rehearsal_log "pass: nothing with the production prefix was addressed, and nothing named for ${PREFIX} was left"
    ;;
  plan)
    # The same refusal, applied to the plan the credential-free dry run printed.
    #
    # `rehearsal_refuse_production_arguments` fails at the moment a command is issued,
    # which means a command nothing on a pull request issues — anything a later edit
    # adds to a real-only branch — is first judged on a credentialed run. That is how
    # the first rehearsal refused itself (Actions 35548888865). So the plan is re-read
    # here: no printed command may name production at all, and the read of the run's
    # own resources must be present, because a plan that quietly stopped reading them
    # would pass a scan for the absence of a string.
    PLAN_FILE=${3:-}
    if [ -z "$PLAN_FILE" ] || [ ! -f "$PLAN_FILE" ]; then
      echo "FAIL: the plan phase needs the file the dry run printed: ...prefix-guard.sh $PREFIX plan <file>" >&2
      exit 1
    fi

    run_reads=0
    offending=0
    while IFS= read -r line; do
      case "$line" in
        *"$PRODUCTION_PREFIX"*)
          echo "FAIL: a rehearsal command names a production resource: $line" >&2
          offending=$((offending + 1))
          continue
          ;;
      esac
      case "$line" in
        *"resourcegroupstaggingapi get-resources"*"$REHEARSAL_RUN_INVENTORY_MARKER $PREFIX")
          run_reads=$((run_reads + 1))
          ;;
      esac
    done < "$PLAN_FILE"

    if [ "$offending" -gt 0 ]; then
      echo "FAIL: $offending planned command(s) would be refused by the rehearsal's own guard" >&2
      exit 1
    fi
    if [ "$run_reads" -lt 1 ]; then
      echo "FAIL: the plan contains no read of the resources named for $PREFIX, so 'the teardown" >&2
      echo "      left nothing behind' would be asserted rather than measured" >&2
      exit 1
    fi
    rehearsal_log "pass: $run_reads read(s) of the run's own resources, and no planned command names production"
    ;;
  *)
    echo "FAIL: phase must be before, after or plan" >&2
    exit 1
    ;;
esac
