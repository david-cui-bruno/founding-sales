#!/usr/bin/env bash
# The old name of `stop.sh` (P7, 26 September 2026). Same flags, same output; kept until
# the release helpers call the new name, then deleted.
#   infra/scripts/release-stop.sh <root> <prefix> [--environment production]
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stop.sh" "$@"
