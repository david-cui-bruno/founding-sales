#!/usr/bin/env bash
# The old name of `deploy.sh bootstrap` (P7, 26 September 2026). Same flags, same output;
# kept until the release helpers call the new name, then deleted.
#   infra/scripts/release-bootstrap-workspace.sh <root> <prefix> --worker-digest D --slug S \
#       --display-name N --admin-email E [--time-zone Z] [--sending-domain DOMAIN] [--environment production]
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.sh" bootstrap "$@"
