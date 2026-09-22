#!/usr/bin/env bash
# List every IAM action a deployment role was seen to make, from CloudTrail's event history.
#
#   infra/scripts/rehearsal-actions-used.sh 2026-09-22T17:00:00Z 2026-09-22T21:00:00Z            # fss-rh-deploy
#   infra/scripts/rehearsal-actions-used.sh 2026-09-22T17:00:00Z 2026-09-22T21:00:00Z fss-rh-deploy > used.json
#
# Read-only. The one AWS call is `aws cloudtrail lookup-events`, which reads the 90-day
# event history of management events and needs no trail. Nothing here is changed and
# nothing secret is printed: a management event carries the action, the caller, the
# resource ARNs, an error code and which service made the call on the caller's behalf;
# CloudTrail does not record secret values, and this script does not print request
# parameters at all.
#
# Why it exists: David's decision of 22 September 2026 to let the rehearsal role hold a
# wide allow for one pass of create, deploy and full, and to derive the exact policy from
# what that pass actually asked AWS for (docs/decisions/g25-discovery-mode-for-the-
# rehearsal-role.md). This is the derivation's input. Output is JSON on stdout: one entry
# per (event source, action), with a count, the error codes seen, which services invoked
# it on the role's behalf, and up to five resource ARNs. A human summary goes to stderr.
#
#   FSS_ACTIONS_USED_AWS=<path>   the CLI to use, for the offline test's stub

set -euo pipefail

START=${1:-}
END=${2:-}
ROLE=${3:-fss-rh-deploy}
AWS=${FSS_ACTIONS_USED_AWS:-aws}

usage() {
  echo "usage: $(basename "$0") <start ISO-8601 UTC> <end ISO-8601 UTC> [fss-rh-deploy|fss-prod-deploy]" >&2
}

for stamp in "$START" "$END"; do
  case "$stamp" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *)
      usage
      echo "FAIL: '$stamp' is not a UTC timestamp of the form 2026-09-22T17:00:00Z" >&2
      exit 2
      ;;
  esac
done

case "$ROLE" in
  fss-rh-deploy | fss-prod-deploy) ;;
  *)
    usage
    echo "FAIL: '$ROLE' is not a deployment role." >&2
    exit 2
    ;;
esac

# The CLI paginates lookup-events itself; --output json returns every page as one document.
events=$(command "$AWS" cloudtrail lookup-events \
  --start-time "$START" --end-time "$END" \
  --query 'Events[].CloudTrailEvent' --output json)

if [ -z "$(printf '%s' "$events" | tr -d '[:space:]')" ]; then
  echo "FAIL: CloudTrail returned nothing for the window. Check the timestamps and the credential." >&2
  exit 1
fi

FSS_ACTIONS_USED_ROLE="$ROLE" FSS_ACTIONS_USED_WINDOW="$START..$END" python3 - "$events" <<'PY'
import json
import os
import sys
from collections import defaultdict

role = os.environ["FSS_ACTIONS_USED_ROLE"]
marker = f":assumed-role/{role}/"
raw = json.loads(sys.argv[1])
if not isinstance(raw, list):
    sys.exit("FAIL: the CLI answer was not a list of events")

seen = {}
total = 0
for text in raw:
    event = json.loads(text) if isinstance(text, str) else text
    identity = event.get("userIdentity") or {}
    arn = identity.get("arn") or ""
    session_arn = ((identity.get("sessionContext") or {}).get("sessionIssuer") or {}).get("arn") or ""
    if marker not in arn and f":role/{role}" not in session_arn:
        continue
    total += 1
    key = (event.get("eventSource", "?"), event.get("eventName", "?"))
    entry = seen.setdefault(
        key,
        {"service": key[0].split(".")[0], "action": key[1], "count": 0, "errors": {}, "invokedBy": set(), "resources": set()},
    )
    entry["count"] += 1
    if event.get("errorCode"):
        entry["errors"][event["errorCode"]] = entry["errors"].get(event["errorCode"], 0) + 1
    invoked = identity.get("invokedBy") or event.get("sourceIPAddress") or ""
    if invoked.endswith(".amazonaws.com"):
        entry["invokedBy"].add(invoked)
    for resource in event.get("resources") or []:
        if resource.get("ARN") and len(entry["resources"]) < 5:
            entry["resources"].add(resource["ARN"])

if total == 0:
    sys.exit(f"FAIL: no event in the window was made by {role}. Widen the window or check the role name.")

rows = []
for (_source, _name), entry in sorted(seen.items(), key=lambda item: (item[1]["service"], item[1]["action"])):
    rows.append(
        {
            "action": f'{entry["service"]}:{entry["action"]}',
            "count": entry["count"],
            "errors": entry["errors"],
            "invokedBy": sorted(entry["invokedBy"]),
            "resources": sorted(entry["resources"]),
        }
    )

refused = [row for row in rows if row["errors"]]
print(
    f"{total} event(s) by {role} in {os.environ['FSS_ACTIONS_USED_WINDOW']}: "
    f"{len(rows)} distinct action(s), {len(refused)} with an error code",
    file=sys.stderr,
)
for row in refused:
    print(f"  refused: {row['action']} {row['errors']}", file=sys.stderr)

print(json.dumps({"role": role, "window": os.environ["FSS_ACTIONS_USED_WINDOW"], "events": total, "actions": rows}, indent=2))
PY
