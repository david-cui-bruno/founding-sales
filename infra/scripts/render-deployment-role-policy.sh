#!/usr/bin/env bash
# The old name of `policy.sh render` (P7, 27 September 2026). Same arguments, same output;
# kept until the release helpers call the new name.
#   infra/scripts/render-deployment-role-policy.sh <fss-rh|fss-prod> [--pretty|--compact|--sids]
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policy.sh" render "$@"
