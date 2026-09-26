#!/usr/bin/env bash
# The old name of `rehearsal.sh ranges` (P7, 27 September 2026). Same arguments, same output;
# kept until the release helpers call the new name. rehearsal.sh has no dry run.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal.sh" ranges "$@"
