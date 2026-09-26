#!/usr/bin/env bash
# The old name of `policy.sh check` (P7, 27 September 2026). Same arguments, output and
# exit status; kept until the release helpers call the new name. A denial now names
# `policy.sh put` as the way to re-put the policy.
#   infra/scripts/check-deployment-role.sh <fss-rh-deploy|fss-prod-deploy> <fss-rh|fss-prod>
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policy.sh" check "$@"
