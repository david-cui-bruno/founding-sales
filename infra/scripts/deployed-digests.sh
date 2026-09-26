#!/usr/bin/env bash
# The old name of `deploy.sh current` (P7, 26 September 2026). Same flags, same output;
# kept until the release helpers call the new name, then deleted.
#   infra/scripts/deployed-digests.sh <prefix> [--var-flags] [--compare <api_image> <worker_image> [--allow-digest-change]]
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.sh" current "$@"
