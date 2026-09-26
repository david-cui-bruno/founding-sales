#!/usr/bin/env bash
# Is today the monthly drill's slot? (`.github/workflows/greenfield-monthly-drill.yml`)
#
#   infra/scripts/ci-schedule.sh slot
#
# GitHub's `schedule` cannot say "the first Sunday of the month": a day-of-month and a
# day-of-week in one cron line match either, not both. So the drill wakes at 06:00 UTC
# on days 1 to 7 of every month and asks this script, which prints `due=true` for the
# Sunday among them (UTC) or for a dispatch by hand, and `due=false` otherwise, with the
# reason on stderr. It reads the clock and nothing else: no API call, no credential.

set -euo pipefail

subcommand_slot() {
  if [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ]; then
    echo "dispatched by hand: due whatever the day" >&2
    echo "due=true"
    return 0
  fi
  local weekday day
  weekday="$(date -u +%u)"
  day="$(date -u +%d)"
  if [ "$weekday" = 7 ] && [ "$((10#$day))" -le 7 ]; then
    echo "due: the first Sunday of the month (UTC)" >&2
    echo "due=true"
  else
    echo "not due: not the first Sunday of the month (UTC)" >&2
    echo "due=false"
  fi
}

case "${1:-}" in
  slot) subcommand_slot ;;
  *)
    echo "usage: $0 slot" >&2
    exit 2
    ;;
esac
