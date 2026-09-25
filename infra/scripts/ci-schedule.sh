#!/usr/bin/env bash
# The two judgements the scheduled workflows make with nothing but the GitHub API
# (lane g74, audit O10 and O11; monthly since lane g97).
#
#   infra/scripts/ci-schedule.sh slot        # greenfield-monthly-drill.yml: is this hour the monthly slot?
#   infra/scripts/ci-schedule.sh freshness   # greenfield-freshness.yml: did the scheduled checks run?
#
# Neither needs a cloud credential and neither may have one: the workflows that run this
# hold `GITHUB_TOKEN` with `actions: read` (and, for `freshness`, `issues: write`), and
# nothing else.
#
# ## `slot`
#
# GitHub's `schedule` cannot read a repository variable, cannot say "the first Sunday of
# the month", and drops or delays events when its queue is busy — on 25 September the
# nightly's 09:00 event never fired at all. So the monthly drill wakes at 06:00 and every
# hour on Sunday (UTC) and asks this script. The slot is the first Sunday of the month
# (day 1 to 7) at `FSS_MONTHLY_DRILL_HOUR_UTC` (default 6, `off` pauses the schedule).
# It prints `due=true` when:
#
#   * the workflow was dispatched by hand (`GITHUB_EVENT_NAME=workflow_dispatch`); or
#   * it is the first Sunday of the month, the slot hour has come, and no earlier run of
#     this workflow since the slot began got as far as pinning its artifacts — so an hour
#     whose event GitHub dropped is caught up by the next one, and a slot that already
#     ran, passed or failed, is not run twice.
#
# Otherwise `due=false`, with the reason on stderr. A value of the variable that is
# neither `off` nor an hour is a failure, not a quiet skip.
#
# ## `freshness`
#
# Two things are meant to happen on a schedule, and a scheduled workflow that silently
# never runs sends no failure e-mail — there is no run to fail:
#
#   * the nightly release mutation check (`greenfield-nightly.yml`): its newest
#     successful run on main must be younger than `FSS_NIGHTLY_MAX_AGE_HOURS` (30);
#   * a green full-mode rehearsal, the monthly drill or a dispatched one: its newest
#     `fss-release-manifest` artifact from main must be younger than
#     `FSS_DRILL_MAX_AGE_HOURS` (864, thirty-six days: first Sundays are at most five
#     weeks apart, and a day more for the run and the rerun), unless the monthly schedule
#     is paused (`FSS_MONTHLY_DRILL_HOUR_UTC=off`), when the age is reported and not
#     alarmed.
#
# "Never" counts as stale once the workflow has existed longer than the threshold. Any
# stale check fails the run and opens — or, if one is open, updates — a single issue
# carrying the marker `<!-- fss-schedule-freshness -->`, mentioning
# `FSS_FRESHNESS_NOTIFY` (the repository owner by default) so the person is e-mailed,
# and asks GitHub to pin it (best effort: the token may not be allowed to). A comment is
# added only when the set of stale checks changes, so twice a day is not twice a day of
# notifications. When everything is fresh again the issue is closed with a comment.
#
# Seams, for `test/release/rehearsalCadence.check.ts`: FSS_GH_COMMAND (default `gh`)
# and FSS_NOW (an ISO instant to use as the present).

set -euo pipefail

DRILL_WORKFLOW='greenfield-monthly-drill.yml'
NIGHTLY_WORKFLOW='greenfield-nightly.yml'
MANIFEST_ARTIFACT='fss-release-manifest'
PIN_JOB_NAME='Pin the three artifacts to this commit'
FRESHNESS_MARKER='<!-- fss-schedule-freshness -->'

schedule_fail() {
  echo "FAIL: $*" >&2
  exit 1
}

schedule_gh() {
  command "${FSS_GH_COMMAND:-gh}" "$@"
}

require_repository() {
  [[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || schedule_fail "GITHUB_REPOSITORY is not owner/name"
}

now_iso() {
  if [ -n "${FSS_NOW:-}" ]; then
    printf '%s' "$FSS_NOW"
  else
    date -u +%Y-%m-%dT%H:%M:%SZ
  fi
}

# ---------------------------------------------------------------------------
# slot
# ---------------------------------------------------------------------------
subcommand_slot() {
  require_repository
  local hour=${FSS_MONTHLY_DRILL_HOUR_UTC:-} event=${GITHUB_EVENT_NAME:-} now decision work runs
  hour=${hour:-6}
  if [ "$hour" = off ]; then
    echo "the monthly drill is paused (FSS_MONTHLY_DRILL_HOUR_UTC=off)" >&2
    if [ "$event" = workflow_dispatch ]; then
      echo "dispatched by hand, so it runs anyway" >&2
      echo "due=true"
      return 0
    fi
    echo "due=false"
    return 0
  fi
  [[ "$hour" =~ ^([01]?[0-9]|2[0-3])$ ]] || schedule_fail "FSS_MONTHLY_DRILL_HOUR_UTC is '$hour'; it must be an hour from 0 to 23, or off"
  if [ "$event" = workflow_dispatch ]; then
    echo "dispatched by hand: due whatever the hour" >&2
    echo "due=true"
    return 0
  fi

  now="$(now_iso)"
  # Before the slot, or not the first Sunday of the month: no API call at all.
  decision="$(FSS_NOW_ISO="$now" FSS_HOUR="$hour" python3 - <<'PY'
import datetime, os
now = datetime.datetime.strptime(os.environ["FSS_NOW_ISO"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
hour = int(os.environ["FSS_HOUR"])
slot = now.replace(hour=hour, minute=0, second=0, microsecond=0)
if now.weekday() != 6:
    print("skip not Sunday (UTC)")
elif now.day > 7:
    print("skip not the first Sunday of the month (UTC)")
elif now < slot:
    print("skip before the slot, {}".format(slot.strftime("%Y-%m-%dT%H:%M:%SZ")))
else:
    print("check " + slot.strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)"
  case "$decision" in
    skip*)
      echo "not due: ${decision#skip }" >&2
      echo "due=false"
      return 0
      ;;
  esac
  local slot=${decision#check }

  work="$(mktemp -d "${TMPDIR:-/tmp}/fss-slot.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now; the local is gone by the time EXIT runs
  trap "rm -rf '$work'" EXIT
  runs="$work/runs.json"
  schedule_gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/$DRILL_WORKFLOW/runs" -f per_page=50 > "$runs" \
    || schedule_fail "the monthly drill's runs could not be listed"
  local earlier id
  earlier="$(FSS_FILE="$runs" FSS_SLOT="$slot" FSS_SELF="${GITHUB_RUN_ID:-}" python3 - <<'PY'
import json, os
document = json.load(open(os.environ["FSS_FILE"], encoding="utf-8"))
for run in document.get("workflow_runs") or []:
    if str(run.get("id")) == os.environ["FSS_SELF"]:
        continue
    if str(run.get("created_at", "")) >= os.environ["FSS_SLOT"]:
        print(run.get("id"))
PY
)"
  for id in $earlier; do
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    schedule_gh api -X GET "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs" -f per_page=100 > "$work/jobs-$id.json" \
      || schedule_fail "the jobs of run $id could not be listed"
    if FSS_FILE="$work/jobs-$id.json" FSS_PIN_JOB="$PIN_JOB_NAME" python3 - <<'PY'
import json, os, sys
document = json.load(open(os.environ["FSS_FILE"], encoding="utf-8"))
for job in document.get("jobs") or []:
    # A pin job that ran, is running or is queued is an attempt; one that was skipped is not.
    if job.get("name") == os.environ["FSS_PIN_JOB"] and job.get("conclusion") != "skipped":
        sys.exit(0)
sys.exit(1)
PY
    then
      echo "not due: run $id already attempted this month's slot ($slot)" >&2
      echo "due=false"
      return 0
    fi
  done
  echo "due: the slot began at $slot and no run since has pinned its artifacts" >&2
  echo "due=true"
}

# ---------------------------------------------------------------------------
# freshness
# ---------------------------------------------------------------------------
subcommand_freshness() {
  require_repository
  local nightly_hours=${FSS_NIGHTLY_MAX_AGE_HOURS:-30} drill_hours=${FSS_DRILL_MAX_AGE_HOURS:-864}
  local notify=${FSS_FRESHNESS_NOTIFY:-${GITHUB_REPOSITORY_OWNER:-}}
  [[ "$nightly_hours" =~ ^[0-9]+$ && "$nightly_hours" -gt 0 ]] || schedule_fail "FSS_NIGHTLY_MAX_AGE_HOURS is not a positive number of hours"
  [[ "$drill_hours" =~ ^[0-9]+$ && "$drill_hours" -gt 0 ]] || schedule_fail "FSS_DRILL_MAX_AGE_HOURS is not a positive number of hours"
  [[ -z "$notify" || "$notify" =~ ^[A-Za-z0-9-]+$ ]] || schedule_fail "FSS_FRESHNESS_NOTIFY is not a GitHub login"

  local work
  work="$(mktemp -d "${TMPDIR:-/tmp}/fss-freshness.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now; the local is gone by the time EXIT runs
  trap "rm -rf '$work'" EXIT
  schedule_gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/$NIGHTLY_WORKFLOW" > "$work/nightly-workflow.json" \
    || schedule_fail "the nightly workflow could not be read"
  schedule_gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/$NIGHTLY_WORKFLOW/runs" \
    -f branch=main -f status=success -f per_page=20 > "$work/nightly-runs.json" \
    || schedule_fail "the nightly workflow's runs could not be listed"
  schedule_gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/$DRILL_WORKFLOW" > "$work/drill-workflow.json" \
    || schedule_fail "the monthly drill workflow could not be read"
  schedule_gh api -X GET "repos/$GITHUB_REPOSITORY/actions/artifacts" \
    -f name="$MANIFEST_ARTIFACT" -f per_page=50 > "$work/manifests.json" \
    || schedule_fail "the release manifests could not be listed"
  schedule_gh api -X GET "repos/$GITHUB_REPOSITORY/issues" -f state=open -f per_page=100 > "$work/issues.json" \
    || schedule_fail "the open issues could not be listed"

  # One program decides; it prints the verdict and writes the issue text for the shell.
  local verdict
  verdict="$(FSS_WORK="$work" FSS_NOW_ISO="$(now_iso)" FSS_NIGHTLY_HOURS="$nightly_hours" FSS_DRILL_HOURS="$drill_hours" \
    FSS_NOTIFY="$notify" FSS_MARKER="$FRESHNESS_MARKER" FSS_REPOSITORY="$GITHUB_REPOSITORY" \
    FSS_DRILL_PAUSED="$([ "${FSS_MONTHLY_DRILL_HOUR_UTC:-}" = off ] && echo yes || echo no)" \
    FSS_SERVER="${GITHUB_SERVER_URL:-https://github.com}" python3 - <<'PY'
# ci-schedule-freshness
import datetime, json, os, re

env = os.environ
work = env["FSS_WORK"]
now = datetime.datetime.strptime(env["FSS_NOW_ISO"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)

def load(name):
    with open(os.path.join(work, name), encoding="utf-8") as handle:
        return json.load(handle)

def instant(value):
    if not isinstance(value, str) or not value:
        return None
    return datetime.datetime.strptime(value[:19] + "Z", "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)

def hours(delta):
    return delta.total_seconds() / 3600.0

def judge(name, newest, created, limit, what):
    if newest is not None:
        age = hours(now - newest)
        fresh = age <= limit
        detail = "last {} {} ({:.1f} h ago; limit {} h)".format(what, newest.strftime("%Y-%m-%dT%H:%M:%SZ"), age, limit)
    elif created is not None and hours(now - created) <= limit:
        fresh = True
        detail = "no {} yet, and the workflow is only {:.1f} h old (limit {} h)".format(what, hours(now - created), limit)
    else:
        fresh = False
        detail = "no {} at all (limit {} h)".format(what, limit)
    return {"name": name, "fresh": fresh, "detail": detail}

nightly_runs = [
    run for run in (load("nightly-runs.json").get("workflow_runs") or [])
    if run.get("conclusion") == "success" and run.get("head_branch") == "main"
]
nightly_newest = max((instant(run.get("run_started_at") or run.get("created_at")) for run in nightly_runs), default=None)
nightly = judge("nightly mutation check", nightly_newest, instant(load("nightly-workflow.json").get("created_at")),
                int(env["FSS_NIGHTLY_HOURS"]), "successful run on main")

manifests = [
    artifact for artifact in (load("manifests.json").get("artifacts") or [])
    if artifact.get("name") == "fss-release-manifest" and not artifact.get("expired")
    and (artifact.get("workflow_run") or {}).get("head_branch") == "main"
]
drill_newest = max((instant(artifact.get("created_at")) for artifact in manifests), default=None)
drill = judge("full rehearsal", drill_newest, instant(load("drill-workflow.json").get("created_at")),
              int(env["FSS_DRILL_HOURS"]), "green full rehearsal (release manifest) from main")
if env["FSS_DRILL_PAUSED"] == "yes" and not drill["fresh"]:
    # Paused on purpose (FSS_MONTHLY_DRILL_HOUR_UTC=off): reported, not alarmed.
    drill = {"name": drill["name"], "fresh": True, "detail": drill["detail"] + "; the monthly schedule is paused"}

checks = [nightly, drill]
stale = [check["name"] for check in checks if not check["fresh"]]

issue = None
for candidate in load("issues.json") or []:
    if "pull_request" in candidate:
        continue
    if env["FSS_MARKER"] in str(candidate.get("body") or ""):
        issue = candidate
        break
previous = []
if issue is not None:
    found = re.search(r"<!-- stale: ([^>]*) -->", str(issue.get("body") or ""))
    if found:
        previous = [part for part in found.group(1).split(",") if part]

summary = ["| check | fresh | detail |", "|---|---|---|"]
for check in checks:
    summary.append("| {} | {} | {} |".format(check["name"], "yes" if check["fresh"] else "**no**", check["detail"]))
table = "\n".join(summary)
workflows = "{}/{}/actions".format(env["FSS_SERVER"], env["FSS_REPOSITORY"])
notify = "cc @{}".format(env["FSS_NOTIFY"]) if env["FSS_NOTIFY"] else ""
body = "\n".join([
    env["FSS_MARKER"],
    "<!-- stale: {} -->".format(",".join(stale)),
    "A scheduled check has not succeeded within its limit. GitHub sends no failure e-mail for a",
    "scheduled run that never started, so this issue is the notice (lane g74, audit O11).",
    "",
    table,
    "",
    "Checked {} by the Greenfield schedule freshness workflow. Runs: {}".format(now.strftime("%Y-%m-%dT%H:%M:%SZ"), workflows),
    "",
    "It is updated while anything is stale and closed when everything is fresh again.",
    notify,
])
with open(os.path.join(work, "summary.md"), "w", encoding="utf-8") as handle:
    handle.write(table + "\n")
with open(os.path.join(work, "body.md"), "w", encoding="utf-8") as handle:
    handle.write(body + "\n")
title = "Scheduled checks are stale: " + ", ".join(stale) if stale else ""
with open(os.path.join(work, "title.txt"), "w", encoding="utf-8") as handle:
    handle.write(title)
changed = "yes" if sorted(previous) != sorted(stale) else "no"
action = ("update" if issue is not None else "open") if stale else ("close" if issue is not None else "none")
print(action, issue.get("number") if issue is not None else "-", changed, len(stale))
PY
)" || schedule_fail "the freshness verdict could not be computed"

  local action number changed stale_count
  read -r action number changed stale_count <<<"$verdict"
  cat "$work/summary.md"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo '## Schedule freshness'; echo; cat "$work/summary.md"; } >> "$GITHUB_STEP_SUMMARY"
  fi

  case "$action" in
    open)
      local created node_id
      created="$(schedule_gh api -X POST "repos/$GITHUB_REPOSITORY/issues" \
        -f title="$(cat "$work/title.txt")" -F body=@"$work/body.md")" || schedule_fail "the freshness issue could not be opened"
      number="$(FSS_JSON="$created" python3 -c 'import json, os; print(json.loads(os.environ["FSS_JSON"]).get("number", ""))')"
      node_id="$(FSS_JSON="$created" python3 -c 'import json, os; print(json.loads(os.environ["FSS_JSON"]).get("node_id", ""))')"
      echo "opened issue #$number"
      if [ -n "$node_id" ]; then
        # shellcheck disable=SC2016
        schedule_gh api graphql -f query='mutation($issue: ID!) { pinIssue(input: {issueId: $issue}) { issue { number } } }' \
          -f issue="$node_id" >/dev/null 2>&1 \
          || echo "::warning::issue #$number is open but could not be pinned; this token may not pin issues"
      fi
      ;;
    update)
      schedule_gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/$number" \
        -f title="$(cat "$work/title.txt")" -F body=@"$work/body.md" >/dev/null \
        || schedule_fail "issue #$number could not be updated"
      if [ "$changed" = yes ]; then
        schedule_gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$number/comments" -F body=@"$work/body.md" >/dev/null \
          || schedule_fail "issue #$number could not be commented on"
      fi
      echo "updated issue #$number"
      ;;
    close)
      printf 'Everything is fresh again.\n\n' > "$work/closing.md"
      cat "$work/summary.md" >> "$work/closing.md"
      schedule_gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$number/comments" -F body=@"$work/closing.md" >/dev/null \
        || schedule_fail "issue #$number could not be commented on"
      schedule_gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/$number" -f state=closed >/dev/null \
        || schedule_fail "issue #$number could not be closed"
      echo "closed issue #$number"
      ;;
    none) ;;
    *) schedule_fail "the freshness verdict '$verdict' is not one this script knows" ;;
  esac

  if [ "$stale_count" != 0 ]; then
    echo "::error title=Scheduled checks are stale::$(cat "$work/title.txt")"
    exit 1
  fi
  echo "every scheduled check is fresh"
}

SUBCOMMAND=${1:-}
shift || true
case "$SUBCOMMAND" in
  slot) subcommand_slot "$@" ;;
  freshness) subcommand_freshness "$@" ;;
  *)
    echo "usage: $(basename "$0") slot | freshness" >&2
    exit 2
    ;;
esac
