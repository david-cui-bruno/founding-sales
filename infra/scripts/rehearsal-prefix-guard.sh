#!/usr/bin/env bash
# The old name of `rehearsal.sh prefix` and `rehearsal.sh guard` (P7, 27 September 2026),
# kept until the release helpers call the new names.
#   infra/scripts/rehearsal-prefix-guard.sh <fss-rh-run> [after]   =  rehearsal.sh guard <fss-rh-run>
#   infra/scripts/rehearsal-prefix-guard.sh <fss-rh-run> before    =  rehearsal.sh prefix <fss-rh-run>
# The guard is no longer a comparison of the run's tagged resources before and after, so
# `before` records nothing; `plan` read the dry run's printed plan, and rehearsal.sh has no
# dry run, so it is refused.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${2:-after}" in
  after) exec "$here/rehearsal.sh" guard "${1:-}" ;;
  before) exec "$here/rehearsal.sh" prefix "${1:-}" ;;
  plan) echo "FAIL: the plan phase is retired (P7): it read a dry run's printed plan, and rehearsal.sh has no dry run" >&2; exit 1 ;;
  *) echo "FAIL: phase must be before, after or plan" >&2; exit 1 ;;
esac
