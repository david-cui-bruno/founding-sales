#!/usr/bin/env bash
# The old name of `deploy.sh ci` (P7, 26 September 2026). Same subcommands, flags and
# output; kept until .github/workflows/greenfield-deploy.yml calls the new name.
#   infra/scripts/ci-deploy-app.sh check|deploy|record <flags>  =  deploy.sh ci check|deploy|record <flags>
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.sh" ci "$@"
