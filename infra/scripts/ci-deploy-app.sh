#!/usr/bin/env bash
# The old name of `deploy.sh ci` (P7, 26 September 2026); it execs it with its arguments
# unchanged. No workflow calls it any more, and it goes with the other old names.
#
# Its interface is deploy.sh ci's, and since P6 (27 September 2026) that is NOT the one
# this name had. These are retired, and refused rather than translated:
#   * --run-started and --run-ended (check, deploy): the push-time window is gone;
#   * --api-range and --worker-range (check, deploy): the ranges are read from the digests
#     artifact (images.sh record writes them);
#   * record without --before-rollout or --after-rollout.
# record and deploy now need --gate-run-id: the gate run the gates job chose, which every
# check before a write must find again (it was record's own input before).
#   infra/scripts/ci-deploy-app.sh check|deploy|record <flags>  =  deploy.sh ci check|deploy|record <flags>
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.sh" ci "$@"
