#!/usr/bin/env bash
# The old name of `rollback.sh` (P7, 27 September 2026). Same flags, same output, same
# report (release-rollback.txt); kept until the release helpers call the new name.
#   infra/scripts/release-rollback.sh <root> <prefix> --api-digest D --worker-digest D [--apply]
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rollback.sh" "$@"
