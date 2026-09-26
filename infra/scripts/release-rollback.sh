#!/usr/bin/env bash
# Put production back on a previous release's images, in one command (lane R1).
#
#   infra/scripts/release-rollback.sh <root> <prefix> --api-digest D --worker-digest D [--apply]
#
#   git -C ~/fss-prod checkout --detach <the previous release's commit>   # then terraform init, as section 4
#   infra/scripts/release-rollback.sh ~/fss-prod/infra/roots/production fss-prod \
#       --api-digest sha256:… --worker-digest sha256:…                    # plans, prints the plan, stops
#   infra/scripts/release-rollback.sh ~/fss-prod/infra/roots/production fss-prod \
#       --api-digest sha256:… --worker-digest sha256:… --apply            # plans again, applies, deploys, smokes
#
# `docs/greenfield/release.md` 4.1a is the operator's page; this is the why.
#
# ## Which code is planned
#
# The checkout that holds `<root>`. The operator checks out the previous release's commit
# there first, and this reads `git rev-parse HEAD` from it: that commit's Terraform is what
# is planned, its declared schema ranges are what the task definitions carry, and its
# `scripts/productionSmoke.mjs` is the smoke, because the smoke holds the running API to
# the ranges of the checkout it runs from. The script itself may run from another
# checkout — a commit from before this lane has no `release-rollback.sh` — and uses the
# `deploy.sh release` and `deploy.sh current` beside it.
#
# ## What it refuses, each in one `FAIL:` line and before anything is written
#
#   1. **Images that are not the checkout's.** Each digest must be an image in
#      `<prefix>-api` / `<prefix>-worker` tagged `ci-<commit>` (a CI promotion) or the bare
#      `<commit>` (an operator's push) for the checked-out commit. A tag names exactly one
#      image in a repository, so an image carrying the tag is the image the tag names. This
#      is what ties the code that will be planned to the images that will run; a dirty
#      checkout is refused for the same reason.
#   2. **A rollback across a schema change.** The database version the running API reports
#      at `/health` must be inside both of the checkout's declared ranges. **The database
#      never rolls back** (release.md 4.1): after a migration the previous images refuse
#      the schema at startup, and the paths are forward repair or the restore protocol.
#   3. **A service mid-rollout**, or a family whose newest revision is not the one that
#      runs: `deploy.sh current`, whose refusal is printed as it gives it.
#   4. **A committed production value that is not what production runs.** Since wave 1
#      (26 September 2026) `infra/roots/production` commits `certificate_arn`,
#      `api_hostname`, `alert_emails` and `sending_enabled` as literals instead of taking
#      them as variables. For each one the checkout commits, the value production runs
#      (below) must equal it; a difference is refused with the manual recovery, because
#      the plan would change the listener, the origin, a subscription or sending.
#   5. **A plan that is more than a rollback.** A rollback registers task definitions and
#      re-points the two services. A plan that creates, replaces or destroys anything but
#      an `aws_ecs_task_definition`, or updates anything but the `api` and `worker`
#      `aws_ecs_service`, is refused and its file deleted, naming every address. An
#      infrastructure difference between the two commits is the manual path of 4.0, read
#      and applied by hand, not a five-minute rollback.
#
# ## What it keeps as production has it
#
# A rollback moves images and nothing an operator decided. So it reads what the running
# deployment carries, not what a file says:
#
#   * `sending_enabled` — `FSS_SENDING_ENABLED` of the running API and worker task
#     definitions, which must agree. The smoke then expects that same state
#     (`--expect-sending`), so a rollback can neither switch sending on nor off;
#   * `expected_system_generation` — `FSS_EXPECTED_SYSTEM_GENERATION`, when it is pinned;
#   * `api_hostname` — the running API's `FSS_PUBLIC_ORIGIN`;
#   * `certificate_arn` — the certificate of the load balancer's HTTPS listener;
#   * `alert_emails` — the e-mail subscriptions of the alert topic;
#   * the image repositories — those of the images that run now, with the given digests.
#
# Those of the last four that the checkout still declares as variables (a commit from
# before wave 1) are passed to its plan as `-var`, exactly as before. Those it commits as
# literals are compared with what runs (refusal 4) and passed as nothing, so the plan uses
# the committed value, which is then the value production runs. Either way the plan
# carries production's settings. The generation pin is always a `-var`.
# A value read wrong shows as a change to the listener, a subscription or a task
# definition's neighbour, which refusal 5 refuses. `bootstrap=false`, and the schema ranges
# are the checkout's (`packages/domain/db/schemaRange.ts`).
#
# ## The plan, and --apply
#
# Without `--apply` it stops after the plan, leaving `rollback.tfplan` in the root and the
# plan's text in the reports directory. With `--apply` it plans again from the same
# reads, judges that plan the same way, applies it, runs `deploy.sh release` on the rolling
# path (never `--schema-change`: nothing migrates), then the canary age and the six smoke
# checks. The root must be initialised as for section 4; after checking out another
# commit, run that `terraform init` again. Terraform runs with every Google credential
# path removed: production has had no Google provider since PR 224, and a commit that still
# had one fails its plan here instead of reaching for a credential.
#
# Offline seams: FSS_REHEARSAL_AWS_COMMAND (the AWS CLI), TERRAFORM, FSS_RELEASE_OUTPUT_*
# (release_output's fixtures), FSS_REHEARSAL_REPORTS, and the waits
# FSS_ROLLBACK_CANARY_ATTEMPTS/_SECONDS and FSS_ROLLBACK_SMOKE_ATTEMPTS/_SECONDS.
# `test/release/releaseRollback.check.ts` drives the whole script against stub `aws`,
# `terraform` and `curl` processes.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every command and calls nothing. It reads the
# checkout (its commit and its ranges), which is local.

ROLLBACK_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/lib.sh
source "$ROLLBACK_SCRIPTS/lib.sh"

PLAN_FILE=rollback.tfplan

rollback_fail() {
  echo "FAIL: $*" >&2
  exit 1
}

usage() {
  echo "usage: release-rollback.sh <terraform root> <name prefix> --api-digest D --worker-digest D [--apply]" >&2
  exit 1
}

ROOT_DIRECTORY=${1:-}
PREFIX=${2:-}
shift 2 2>/dev/null || true
API_DIGEST=''
WORKER_DIGEST=''
APPLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --api-digest) [ "$#" -ge 2 ] || usage; API_DIGEST=$2; shift 2 ;;
    --worker-digest) [ "$#" -ge 2 ] || usage; WORKER_DIGEST=$2; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) rollback_fail "release-rollback.sh does not take '$1'" ;;
  esac
done
if [ -z "$ROOT_DIRECTORY" ] || [ -z "$PREFIX" ]; then usage; fi

ENVIRONMENT="$(release_environment_for_prefix "$PREFIX")" || exit 1
if [ "$ENVIRONMENT" != production ]; then
  rollback_fail "'$PREFIX' is a rehearsal prefix. A rehearsal is torn down after every run, so there is nothing to roll it back to; this is production's."
fi
case "$ROOT_DIRECTORY" in
  *roots/production) ;;
  *) rollback_fail "prefix '$PREFIX' is production and '$ROOT_DIRECTORY' is not the production root" ;;
esac
[ -d "$ROOT_DIRECTORY" ] || rollback_fail "'$ROOT_DIRECTORY' is not a directory"
for digest in "$API_DIGEST" "$WORKER_DIGEST"; do
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || rollback_fail "'${digest:-<none>}' is not an image digest (sha256:<64 hex>); pass both --api-digest and --worker-digest"
done
[ "$API_DIGEST" != "$WORKER_DIGEST" ] || rollback_fail "the API and worker digests are identical; one image is not both services"

REPORTS="$(rehearsal_report_dir)"
mkdir -p "$REPORTS"
PLAN_TEXT="$REPORTS/rollback-plan.txt"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fss-rollback.XXXXXX")"
# shellcheck disable=SC2064 # the path is fixed now
trap "rm -rf '$WORK'" EXIT
mkdir -p "$WORK/no-google"

# Every Terraform call: the production refusal of foreign names, the dry run, and no
# Google credential path in reach (the header says why).
rollback_terraform() {
  release_refuse_foreign_arguments production "$@" || return 1
  if rehearsal_dry_run; then
    rehearsal_plan "terraform $*"
    return 0
  fi
  env -u GOOGLE_APPLICATION_CREDENTIALS -u GOOGLE_CREDENTIALS -u GOOGLE_OAUTH_ACCESS_TOKEN \
    CLOUDSDK_CONFIG="$WORK/no-google" "${TERRAFORM:-terraform}" "$@"
}

# ---------------------------------------------------------------------------
# The checkout: its commit, clean, and its declared ranges.
# ---------------------------------------------------------------------------
CHECKOUT="$(git -C "$ROOT_DIRECTORY" rev-parse --show-toplevel 2>/dev/null)" \
  || rollback_fail "'$ROOT_DIRECTORY' is not inside a git checkout; check out the previous release's commit and pass the production root inside it"
COMMIT="$(git -C "$CHECKOUT" rev-parse HEAD)"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || rollback_fail "the checkout at $CHECKOUT has no commit"
# A stale saved plan is not a dirty checkout, and is never one to apply.
if ! rehearsal_dry_run; then rm -f "$ROOT_DIRECTORY/$PLAN_FILE"; fi
DIRTY="$(git -C "$CHECKOUT" status --porcelain --untracked-files=all | grep -vE '\.tfplan$' || true)"
if [ -n "$DIRTY" ]; then
  rollback_fail "the checkout at $CHECKOUT is not clean ($(printf '%s' "$DIRTY" | head -1 | sed 's/^ *//')): the code planned would not be $COMMIT's"
fi

RANGES="$(FSS_SCHEMA_RANGE_FILE="$CHECKOUT/packages/domain/db/schemaRange.ts" node --experimental-transform-types \
  --disable-warning=ExperimentalWarning --input-type=module -e "
    const { pathToFileURL } = await import('node:url');
    const m = await import(pathToFileURL(process.env.FSS_SCHEMA_RANGE_FILE).href);
    const r = [m.API_SCHEMA_RANGE, m.WORKER_SCHEMA_RANGE];
    process.stdout.write(r.map(x => String(x.minimum) + ' ' + String(x.maximum)).join(' '));
  ")" || RANGES=''
[[ "$RANGES" =~ ^[0-9]{1,4}\ [0-9]{1,4}\ [0-9]{1,4}\ [0-9]{1,4}$ ]] \
  || rollback_fail "the schema ranges of $COMMIT could not be read from packages/domain/db/schemaRange.ts"
read -r API_MIN API_MAX WORKER_MIN WORKER_MAX <<<"$RANGES"

rehearsal_log "rolling $PREFIX back to $COMMIT (checkout $CHECKOUT): api $API_DIGEST, worker $WORKER_DIGEST"
rehearsal_log "$COMMIT declares api $API_MIN-$API_MAX and worker $WORKER_MIN-$WORKER_MAX"

# ---------------------------------------------------------------------------
# 1. The digests are this commit's images, in production's registry.
# ---------------------------------------------------------------------------
for service in api worker; do
  want=$API_DIGEST
  [ "$service" = worker ] && want=$WORKER_DIGEST
  if rehearsal_dry_run; then
    release_aws production ecr describe-images --repository-name "$PREFIX-$service" --image-ids "imageDigest=$want" --output json
    rehearsal_plan "refuse unless $PREFIX-$service's $want is tagged ci-$COMMIT or $COMMIT"
    continue
  fi
  described="$(release_aws production ecr describe-images --repository-name "$PREFIX-$service" \
    --image-ids "imageDigest=$want" --output json)" \
    || rollback_fail "$PREFIX-$service holds no image $want (the CLI's answer is above): a rollback runs images already in production's registry"
  tags="$(FSS_JSON="$described" FSS_DIGEST="$want" python3 -c '
import json, os
details = (json.loads(os.environ["FSS_JSON"] or "{}") or {}).get("imageDetails") or []
detail = details[0] if len(details) == 1 and details[0].get("imageDigest") == os.environ["FSS_DIGEST"] else {}
print(" ".join(sorted(detail.get("imageTags") or [])))
')"
  case " $tags " in
    *" ci-$COMMIT "* | *" $COMMIT "*) rehearsal_log "$PREFIX-$service $want is tagged $( [[ " $tags " == *" ci-$COMMIT "* ]] && echo "ci-$COMMIT" || echo "$COMMIT" )" ;;
    *) rollback_fail "$PREFIX-$service's $want is tagged ${tags:-<nothing>}, not ci-$COMMIT or $COMMIT: it is not an image of the checked-out commit, and the plan would pair this commit's code with another's image. Check out the commit those digests were built from." ;;
  esac
done

# ---------------------------------------------------------------------------
# 2. What production runs now, and nothing mid-rollout (deploy.sh current).
# ---------------------------------------------------------------------------
if rehearsal_dry_run; then
  rehearsal_plan "$ROLLBACK_SCRIPTS/deploy.sh current $PREFIX   (refuses while either service is mid-rollout)"
  API_IMAGE="<the fss-prod-api repository>@$API_DIGEST"
  WORKER_IMAGE="<the fss-prod-worker repository>@$WORKER_DIGEST"
else
  DEPLOYED="$("$ROLLBACK_SCRIPTS/deploy.sh" current "$PREFIX")" \
    || { echo "      nothing was planned: deploy.sh current refused, above" >&2; exit 1; }
  RUNNING_API="$(printf '%s\n' "$DEPLOYED" | sed -n 's/^api_image=//p')"
  RUNNING_WORKER="$(printf '%s\n' "$DEPLOYED" | sed -n 's/^worker_image=//p')"
  case "$RUNNING_API:$RUNNING_WORKER" in
    */"$PREFIX-api@"*:*/"$PREFIX-worker@"*) ;;
    *) rollback_fail "deploy.sh current did not name an image of $PREFIX-api and one of $PREFIX-worker" ;;
  esac
  rehearsal_log "production runs $RUNNING_API and $RUNNING_WORKER"
  if [ "${RUNNING_API##*@}" = "$API_DIGEST" ] && [ "${RUNNING_WORKER##*@}" = "$WORKER_DIGEST" ]; then
    rehearsal_log "production already runs both digests; there is nothing to roll back"
    exit 0
  fi
  API_IMAGE="${RUNNING_API%@*}@$API_DIGEST"
  WORKER_IMAGE="${RUNNING_WORKER%@*}@$WORKER_DIGEST"
fi

# ---------------------------------------------------------------------------
# 3. What the running deployment carries: sending, the generation pin, the hostname.
# ---------------------------------------------------------------------------
if rehearsal_dry_run; then
  release_aws production ecs describe-task-definition --task-definition "$PREFIX-api" --output json
  release_aws production ecs describe-task-definition --task-definition "$PREFIX-worker" --output json
  rehearsal_plan "read FSS_SENDING_ENABLED (both, which must agree), FSS_EXPECTED_SYSTEM_GENERATION and the API's FSS_PUBLIC_ORIGIN"
  SENDING='<FSS_SENDING_ENABLED as it runs>'
  GENERATION='-'
  API_HOSTNAME='<the host of FSS_PUBLIC_ORIGIN>'
else
  for service in api worker; do
    release_aws production ecs describe-task-definition --task-definition "$PREFIX-$service" --output json \
      >"$WORK/$service-definition.json" || rollback_fail "ECS did not describe $PREFIX-$service's task definition"
  done
  FLAGS="$(FSS_WORK="$WORK" FSS_PREFIX="$PREFIX" python3 - <<'PY'
# release-rollback-flags
import json, os, re, sys
env = {}
for service in ("api", "worker"):
    definition = (json.load(open(os.path.join(os.environ["FSS_WORK"], service + "-definition.json"), encoding="utf-8")) or {}).get("taskDefinition") or {}
    container = next((c for c in definition.get("containerDefinitions") or [] if c.get("name") == service), None)
    if container is None:
        sys.exit("FAIL: {}-{} has no container named {}".format(os.environ["FSS_PREFIX"], service, service))
    env[service] = {item.get("name"): item.get("value") for item in container.get("environment") or []}
sending = [env[s].get("FSS_SENDING_ENABLED") for s in ("api", "worker")]
if any(value not in ("true", "false") for value in sending) or sending[0] != sending[1]:
    sys.exit("FAIL: FSS_SENDING_ENABLED is {} on the API and {} on the worker; a rollback keeps sending as it is, and there is no one state to keep".format(*sending))
generation = [env[s].get("FSS_EXPECTED_SYSTEM_GENERATION") for s in ("api", "worker")]
if generation[0] != generation[1] or (generation[0] is not None and not re.fullmatch(r"[1-9][0-9]{0,9}", generation[0])):
    sys.exit("FAIL: FSS_EXPECTED_SYSTEM_GENERATION is {} on the API and {} on the worker; a rollback keeps the pin as it is, and there is no one pin to keep".format(*generation))
origin = env["api"].get("FSS_PUBLIC_ORIGIN") or ""
match = re.fullmatch(r"https://([a-z0-9.-]+)", origin)
if not match:
    sys.exit("FAIL: the running API's FSS_PUBLIC_ORIGIN is '{}', not an https origin".format(origin))
print(sending[0], generation[0] or "-", match.group(1))
PY
)" || exit 1
  read -r SENDING GENERATION API_HOSTNAME <<<"$FLAGS"
fi
EXPECT_SENDING=disabled
[ "$SENDING" = true ] && EXPECT_SENDING=enabled
if rehearsal_dry_run; then EXPECT_SENDING='<enabled or disabled, as FSS_SENDING_ENABLED runs>'; fi
ORIGIN="https://$API_HOSTNAME"
rehearsal_log "sending_enabled=$SENDING, expected_system_generation=$( [ "$GENERATION" = - ] && echo unpinned || echo "$GENERATION" ), api_hostname=$API_HOSTNAME, as production runs them"

# ---------------------------------------------------------------------------
# 4. The database version, against the checkout's ranges. It never rolls back.
# ---------------------------------------------------------------------------
if rehearsal_dry_run; then
  rehearsal_plan "curl -fsS --max-time 15 $ORIGIN/health"
  rehearsal_plan "refuse unless schema.databaseVersion is inside api $API_MIN-$API_MAX and worker $WORKER_MIN-$WORKER_MAX"
  DATABASE_VERSION='<read>'
else
  HEALTH="$(curl -fsS --max-time 15 "$ORIGIN/health")" \
    || rollback_fail "$ORIGIN/health did not answer: without the database's schema version nothing can say whether $COMMIT's images accept it, and the database never rolls back"
  DATABASE_VERSION="$(FSS_JSON="$HEALTH" python3 -c '
import json, os
version = ((json.loads(os.environ["FSS_JSON"] or "{}") or {}).get("schema") or {}).get("databaseVersion")
print(version if isinstance(version, int) and not isinstance(version, bool) else "")
' 2>/dev/null || true)"
  [[ "$DATABASE_VERSION" =~ ^[0-9]{1,4}$ ]] \
    || rollback_fail "$ORIGIN/health reports no schema.databaseVersion, so nothing can say whether $COMMIT's images accept the database"
  if [ "$DATABASE_VERSION" -lt "$API_MIN" ] || [ "$DATABASE_VERSION" -gt "$API_MAX" ] \
    || [ "$DATABASE_VERSION" -lt "$WORKER_MIN" ] || [ "$DATABASE_VERSION" -gt "$WORKER_MAX" ]; then
    rollback_fail "the database is at schema $DATABASE_VERSION and $COMMIT declares api $API_MIN-$API_MAX and worker $WORKER_MIN-$WORKER_MAX: that is a rollback across a schema change, and the database never rolls back (release.md 4.1). The paths are forward repair or the restore protocol."
  fi
  rehearsal_log "the database is at schema $DATABASE_VERSION, which api $API_MIN-$API_MAX and worker $WORKER_MIN-$WORKER_MAX accept"
fi

# ---------------------------------------------------------------------------
# 5. The edge and the alert recipients, as production has them.
# ---------------------------------------------------------------------------
TOPIC_ARN="$(release_output "$ROOT_DIRECTORY" alert_topic_arn)"
if rehearsal_dry_run; then
  release_aws production elbv2 describe-load-balancers --names "$PREFIX-alb" --output json
  release_aws production elbv2 describe-listeners --load-balancer-arn "<the $PREFIX-alb ARN>" --output json
  release_aws production sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN:-<alert_topic_arn>}" --output json
  CERTIFICATE_ARN='<the HTTPS listener certificate>'
  ALERT_EMAILS='<the alert topic e-mail subscriptions>'
else
  [[ "$TOPIC_ARN" =~ ^arn:aws[a-z-]*:sns:[a-z0-9-]+:[0-9]{12}:${PREFIX}-[A-Za-z0-9_-]+$ ]] \
    || rollback_fail "the root's alert_topic_arn is '${TOPIC_ARN:-<empty>}', not an SNS topic of $PREFIX"
  balancers="$(release_aws production elbv2 describe-load-balancers --names "$PREFIX-alb" --output json)" \
    || rollback_fail "the load balancer $PREFIX-alb could not be described"
  BALANCER_ARN="$(release_json_path "$balancers" LoadBalancers.0.LoadBalancerArn)"
  [[ "$BALANCER_ARN" =~ ^arn:aws[a-z-]*:elasticloadbalancing:.*/${PREFIX}-alb/ ]] \
    || rollback_fail "ELB did not answer with the ARN of $PREFIX-alb"
  listeners="$(release_aws production elbv2 describe-listeners --load-balancer-arn "$BALANCER_ARN" --output json)" \
    || rollback_fail "the listeners of $PREFIX-alb could not be described"
  CERTIFICATE_ARN="$(FSS_JSON="$listeners" python3 -c '
import json, os
https = [l for l in (json.loads(os.environ["FSS_JSON"] or "{}") or {}).get("Listeners") or [] if l.get("Protocol") == "HTTPS"]
certificates = [c.get("CertificateArn") for l in https for c in l.get("Certificates") or []]
print(certificates[0] if len(https) == 1 and len(certificates) == 1 else "")
')"
  [[ "$CERTIFICATE_ARN" =~ ^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/[A-Za-z0-9-]+$ ]] \
    || rollback_fail "$PREFIX-alb has no single HTTPS listener with one certificate, so there is no certificate_arn to keep"
  subscriptions="$(release_aws production sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --output json)" \
    || rollback_fail "the subscriptions of $TOPIC_ARN could not be listed"
  ALERT_EMAILS="$(FSS_JSON="$subscriptions" python3 -c '
import json, os, re, sys
rows = (json.loads(os.environ["FSS_JSON"] or "{}") or {}).get("Subscriptions") or []
emails = sorted({r.get("Endpoint") for r in rows if r.get("Protocol") == "email"})
if any(not re.fullmatch(r"[^@\s\"\\]+@[^@\s\"\\]+\.[^@\s\"\\]+", e or "") for e in emails):
    sys.exit("FAIL: the alert topic has an e-mail subscription that is not an address")
print(json.dumps(emails, separators=(",", ":")))
')" || exit 1
fi
rehearsal_log "certificate_arn=$CERTIFICATE_ARN, alert_emails=$ALERT_EMAILS, as production has them"

# ---------------------------------------------------------------------------
# 6. What the checkout commits, against what production runs (refusal 4).
#
# For each of the four settings: a checkout that declares it as a variable is given
# production's value as a `-var`; one that commits it as a literal must commit exactly
# production's value, and is given nothing. The literal is the one line `<name> = <value>`
# in the root's own `*.tf` whose value is a string, a list of strings or a boolean (the
# `locals` block of `infra/roots/production/main.tf`). The answer is one `<name> var` or
# `<name> committed` line per setting.
# ---------------------------------------------------------------------------
SETTINGS="$(FSS_ROOT="$ROOT_DIRECTORY" FSS_COMMIT="$COMMIT" FSS_DRY="$(rehearsal_dry_run && echo 1 || echo 0)" \
  FSS_LIVE_CERTIFICATE_ARN="$CERTIFICATE_ARN" FSS_LIVE_API_HOSTNAME="$API_HOSTNAME" \
  FSS_LIVE_ALERT_EMAILS="$ALERT_EMAILS" FSS_LIVE_SENDING_ENABLED="$SENDING" python3 - <<'PY'
# release-rollback-committed
import glob, json, os, re, sys
root, commit, dry = os.environ["FSS_ROOT"], os.environ["FSS_COMMIT"], os.environ["FSS_DRY"] == "1"
text = "\n".join(open(path, encoding="utf-8").read() for path in sorted(glob.glob(os.path.join(root, "*.tf"))))
literal = {
    "certificate_arn": r'"([^"\n]+)"',
    "api_hostname": r'"([^"\n]+)"',
    "alert_emails": r'(\[[^\]\n]*\])',
    "sending_enabled": r'(true|false)',
}
def canonical(name, value):
    if name == "alert_emails":
        return json.dumps(sorted(set(json.loads(value))), separators=(",", ":"))
    return value
mismatched = []
for name, pattern in literal.items():
    if re.search(r'^variable "' + name + r'" *\{', text, re.M):
        print(name, "var")
        continue
    found = re.findall(r'^[ \t]*' + name + r'[ \t]*=[ \t]*' + pattern + r'[ \t]*$', text, re.M)
    if len(found) != 1:
        sys.exit("FAIL: {} neither declares {} as a variable nor commits it as one literal (it has {}), so there is no value to plan it with; nothing was planned".format(commit, name, len(found)))
    try:
        committed = canonical(name, found[0])
    except ValueError:
        sys.exit("FAIL: {} commits {} = {}, which is not a list of strings; nothing was planned".format(commit, name, found[0]))
    if dry:
        sys.stderr.write("PLAN refuse unless production's {} equals the committed {}\n".format(name, committed))
    else:
        live = canonical(name, os.environ["FSS_LIVE_" + name.upper()])
        if live != committed:
            mismatched.append("{} is {} in production and {} in {}".format(name, live, committed, commit))
    print(name, "committed")
if mismatched:
    sys.exit("FAIL: " + "; ".join(mismatched) + ". A rollback moves images and nothing an operator decided, and this plan would change what production runs, so nothing was planned. Manual recovery: decide which value is right. If production's, roll back by hand on the manual path (release.md 4.0) and correct the literal in infra/roots/production in a pull request; if the committed one, production has drifted, so put it back with a plan and apply of main (release.md 4.0) and run this again.")
PY
)" || exit 1
declared() { printf '%s\n' "$SETTINGS" | grep -qx "$1 var"; }
rehearsal_log "the checkout's root: $(printf '%s' "$SETTINGS" | tr '\n' ',' | sed 's/,/, /g')"

# ---------------------------------------------------------------------------
# 7. The plan, and the judgement of it.
# ---------------------------------------------------------------------------
PLAN_VARIABLES=()
if declared certificate_arn; then PLAN_VARIABLES+=(-var="certificate_arn=$CERTIFICATE_ARN"); fi
if declared api_hostname; then PLAN_VARIABLES+=(-var="api_hostname=$API_HOSTNAME"); fi
PLAN_VARIABLES+=(
  -var="api_image=$API_IMAGE"
  -var="worker_image=$WORKER_IMAGE"
  -var="api_schema_range={min=$API_MIN,max=$API_MAX}"
  -var="worker_schema_range={min=$WORKER_MIN,max=$WORKER_MAX}"
)
if declared alert_emails; then PLAN_VARIABLES+=(-var="alert_emails=$ALERT_EMAILS"); fi
if declared sending_enabled; then PLAN_VARIABLES+=(-var="sending_enabled=$SENDING"); fi
PLAN_VARIABLES+=(-var="bootstrap=false")
if [ "$GENERATION" != - ]; then PLAN_VARIABLES+=(-var="expected_system_generation=$GENERATION"); fi

rehearsal_log "plan: $ROOT_DIRECTORY/$PLAN_FILE"
if rehearsal_dry_run; then
  rollback_terraform -chdir="$ROOT_DIRECTORY" plan -input=false -no-color -out="$PLAN_FILE" "${PLAN_VARIABLES[@]}"
  rollback_terraform -chdir="$ROOT_DIRECTORY" show -json "$PLAN_FILE"
  rehearsal_plan "refuse, deleting $PLAN_FILE, unless it creates, replaces or destroys only aws_ecs_task_definition and updates only aws_ecs_service api and worker"
else
  if ! rollback_terraform -chdir="$ROOT_DIRECTORY" plan -input=false -no-color -out="$PLAN_FILE" "${PLAN_VARIABLES[@]}" \
    >"$PLAN_TEXT" 2>&1; then
    tail -20 "$PLAN_TEXT" >&2
    rm -f "$ROOT_DIRECTORY/$PLAN_FILE"
    rollback_fail "terraform plan failed (the end of it is above; all of it is in $PLAN_TEXT). Nothing was applied."
  fi
  grep -E '^(Plan:|No changes)' "$PLAN_TEXT" || true
  # Straight from `terraform show` into the judge: the JSON carries prior state, and it
  # is never written anywhere.
  if ! rollback_terraform -chdir="$ROOT_DIRECTORY" show -json "$PLAN_FILE" | python3 -c '
# release-rollback-plan
import json, sys
try:
    plan = json.load(sys.stdin)
except ValueError:
    sys.exit("FAIL: terraform show did not print the saved plan, so it cannot be judged")
allowed, refused = [], []
for change in plan.get("resource_changes") or []:
    actions = (change.get("change") or {}).get("actions") or []
    if change.get("mode") == "data" or actions in (["no-op"], ["read"]):
        continue
    verb = "replace" if sorted(actions) == ["create", "delete"] else "+".join(actions)
    kind, name, address = change.get("type"), change.get("name"), change.get("address")
    line = "{} {}".format(verb, address)
    if kind == "aws_ecs_task_definition" and verb in ("create", "delete", "replace"):
        allowed.append(line)
    elif kind == "aws_ecs_service" and name in ("api", "worker") and verb == "update":
        allowed.append(line)
    else:
        refused.append(line)
for line in allowed + refused:
    print("  " + line)
if refused:
    sys.exit("FAIL: the rollback plan would " + ", ".join(refused) + ". A rollback registers task definitions and re-points the api and worker services, nothing else; the plan file is deleted. An infrastructure difference between the two commits is the manual path (release.md 4.0).")
if not allowed:
    sys.exit("FAIL: the rollback plan changes nothing, and production does not run these digests; the plan file is deleted")
'; then
    rm -f "$ROOT_DIRECTORY/$PLAN_FILE"
    exit 1
  fi
fi

if [ "$APPLY" != 1 ]; then
  rehearsal_log "plan saved: $ROOT_DIRECTORY/$PLAN_FILE; the whole of it is in $PLAN_TEXT"
  rehearsal_log "read it: each task definition replaced with $API_DIGEST or $WORKER_DIGEST and the ranges above, FSS_SENDING_ENABLED still $SENDING, and each service re-pointed. Then run this again with --apply, which plans again, judges it the same way and applies it."
  rehearsal_write_report "release-rollback.txt" \
    "prefix=$PREFIX commit=$COMMIT api_digest=$API_DIGEST worker_digest=$WORKER_DIGEST sending_enabled=$SENDING database_version=$DATABASE_VERSION applied=no"
  exit 0
fi

# ---------------------------------------------------------------------------
# 8. --apply: the apply, the rolling deploy, the smoke.
# ---------------------------------------------------------------------------
rehearsal_log "apply $PLAN_FILE"
if rehearsal_dry_run; then
  rollback_terraform -chdir="$ROOT_DIRECTORY" apply -input=false -no-color "$PLAN_FILE"
else
  rollback_terraform -chdir="$ROOT_DIRECTORY" apply -input=false -no-color "$PLAN_FILE" 2>&1 | tee "$REPORTS/rollback-apply.txt" \
    || rollback_fail "terraform apply failed (above, and in $REPORTS/rollback-apply.txt); read what it changed before anything else"
  rm -f "$ROOT_DIRECTORY/$PLAN_FILE"
fi

rehearsal_log "the rolling deploy of $COMMIT's task definitions (no --schema-change: nothing migrates)"
if rehearsal_dry_run; then
  rehearsal_plan "$ROLLBACK_SCRIPTS/deploy.sh release $ROOT_DIRECTORY $PREFIX --api-digest $API_DIGEST --worker-digest $WORKER_DIGEST"
else
  "$ROLLBACK_SCRIPTS/deploy.sh" release "$ROOT_DIRECTORY" "$PREFIX" --api-digest "$API_DIGEST" --worker-digest "$WORKER_DIGEST" \
    || { echo "      the apply has put $COMMIT's task definitions on both services, and deploy.sh release did not confirm them running (above)" >&2; exit 1; }
fi

rehearsal_log "the canary age and the six smoke checks, expecting sending $EXPECT_SENDING"
SMOKE=(node "$CHECKOUT/scripts/productionSmoke.mjs" --origin "$ORIGIN" --canary-age-seconds)
if rehearsal_dry_run; then
  release_aws production cloudwatch get-metric-statistics --namespace "FSS/$PREFIX" --metric-name CanaryCompletionAgeSeconds \
    --statistics Maximum --start-time "<an hour ago>" --end-time "<now>" --period 300 --output json
  rehearsal_plan "${SMOKE[*]} <the newest Maximum> --expect-sending $EXPECT_SENDING"
  exit 0
fi
AGE=''
attempts=${FSS_ROLLBACK_CANARY_ATTEMPTS:-5}
for attempt in $(seq 1 "$attempts"); do
  read -r START END <<<"$(python3 -c '
from datetime import datetime, timedelta, timezone
now = datetime.now(timezone.utc).replace(microsecond=0)
print((now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"), now.strftime("%Y-%m-%dT%H:%M:%SZ"))
')"
  statistics="$(release_aws production cloudwatch get-metric-statistics --namespace "FSS/$PREFIX" \
    --metric-name CanaryCompletionAgeSeconds --statistics Maximum --start-time "$START" --end-time "$END" \
    --period 300 --output json)" || statistics=''
  AGE="$(FSS_JSON="$statistics" python3 -c '
import json, os
points = sorted((json.loads(os.environ["FSS_JSON"] or "{}") or {}).get("Datapoints") or [], key=lambda p: str(p.get("Timestamp")))
value = points[-1].get("Maximum") if points else None
print(value if isinstance(value, (int, float)) and not isinstance(value, bool) else "")
' 2>/dev/null || true)"
  [ -n "$AGE" ] && break
  rehearsal_log "no CanaryCompletionAgeSeconds datapoint yet (attempt $attempt of $attempts)"
  [ "$attempt" -eq "$attempts" ] || sleep "${FSS_ROLLBACK_CANARY_SECONDS:-60}"
done
[ -n "$AGE" ] \
  || rollback_fail "FSS/$PREFIX published no CanaryCompletionAgeSeconds, so the smoke has nothing to judge; $COMMIT's images are running"
rehearsal_log "canary age ${AGE}s"

attempts=${FSS_ROLLBACK_SMOKE_ATTEMPTS:-3}
for attempt in $(seq 1 "$attempts"); do
  if NODE_OPTIONS="--experimental-transform-types --disable-warning=ExperimentalWarning" \
    "${SMOKE[@]}" "$AGE" --expect-sending "$EXPECT_SENDING"; then
    rehearsal_write_report "release-rollback.txt" \
      "prefix=$PREFIX commit=$COMMIT api_digest=$API_DIGEST worker_digest=$WORKER_DIGEST sending_enabled=$SENDING database_version=$DATABASE_VERSION applied=yes smoke=pass"
    rehearsal_log "rolled back to $COMMIT: api $API_DIGEST, worker $WORKER_DIGEST, sending $EXPECT_SENDING"
    exit 0
  fi
  rehearsal_log "smoke attempt $attempt of $attempts did not pass"
  [ "$attempt" -eq "$attempts" ] || sleep "${FSS_ROLLBACK_SMOKE_SECONDS:-60}"
done
rollback_fail "the production smoke did not pass; $COMMIT's images are running (deploy.sh release confirmed them)"
