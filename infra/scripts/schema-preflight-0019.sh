#!/usr/bin/env bash
# The old name of `preflight.sh <root> <prefix> 0019` (P7, 27 September 2026). Same
# arguments, the same reports (schema-preflight-0019.txt, .json, .log) and exit status
# (0 applies, 3 refuses, 1 failed); the summary line now carries the schema version,
# `refuses` and the blocking counts only. Kept until the release helpers call the new name.
#   infra/scripts/schema-preflight-0019.sh <root> <prefix> --worker-digest D
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/preflight.sh" "${1:-}" "${2:-}" 0019 "${@:3}"
