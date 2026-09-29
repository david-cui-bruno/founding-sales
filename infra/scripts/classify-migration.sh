#!/usr/bin/env bash
# What a migration does, in one word, with the statements that decided it.
#
#   infra/scripts/classify-migration.sh <packages/domain/db/migrations/NNNN_name.sql> [--applied-on=N]
#
# Prints `additive`, `replaces-routine`, `touches-existing`, `privilege`, `destructive`
# or `unclassified` on the first line and the deciding statements after it, and exits 0.
# The release procedure (docs/greenfield/release.md 3) rehearses `touches-existing`,
# `privilege`, `destructive` and `unclassified`, and not `additive` or
# `replaces-routine`, which the upgrade test covers instead.
#
# "Existing" is the set of tables migrations 1..N of the same directory leave behind,
# where N is the file's own number minus one unless `--applied-on=` says otherwise; no
# database is read and nothing is guessed from a name. The logic is
# `tools/upgrade/classify.ts` so that `npm run upgrade:test` prints the same answer from
# the same code; this file is the operator's way in. It makes no cloud call.
set -euo pipefail
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
# `--experimental-transform-types` for the same reason the two Dockerfiles use it:
# `packages/domain` has constructor parameter properties, which strip-only mode refuses.
exec node --experimental-transform-types --disable-warning=ExperimentalWarning \
  "$repository_root/tools/upgrade/classifyMain.ts" "$@"
