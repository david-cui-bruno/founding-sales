#!/usr/bin/env bash
# Appendix G 20: "Post-watermark sends and suppressions exist; the old stack is
# read-only and cannot be rollback."
#
#   infra/scripts/rehearsal-carry-watermark.sh <fss-rh-run>
#
# 17: "Cutover establishes a write watermark, imports and reconciles the final delta,
# verifies counts and hashes, then makes the old stack read-only. New activity never
# returns to the old stack, and the old stack is not a rollback target."
#
# Two claims, and they fail in different ways.
#
# **The watermark is enforced.** G11's export refuses to produce a carry when the old
# table holds a write after the watermark, because such a write would be lost silently.
# `apps/worker/test/carry/*.test.ts` proves that against the recorded fixtures,
# including `tableWithPostWatermarkWrite`. What only a rehearsal adds is that the real
# export path, with the real reader, refuses the same way.
#
# **The old stack cannot be a rollback target.** This is an absence, and the only
# honest way to assert an absence is to try. The script asserts that the greenfield
# roots declare no old state key (which `infra/scripts/offline-gate.sh` also checks)
# and that the carry tooling has no import direction at all — there is a reader for the
# old table and no writer, so "roll back to the old stack" is not a command that exists.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints the plan and needs no credential.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

PREFIX=${1:-}
rehearsal_require_prefix "$PREFIX"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPORTS="$(rehearsal_report_dir)"
mkdir -p "$REPORTS"

# ---------------------------------------------------------------------------
# 1. The old stack has no writer. Checked in the source, because it is a property of
#    what exists rather than of what runs.
# ---------------------------------------------------------------------------
rehearsal_log "asserting the carry tooling can read the old table and cannot write to it"
writers="$(grep -rInE 'PutItemCommand|UpdateItemCommand|DeleteItemCommand|BatchWriteItemCommand' \
  "$ROOT/apps/worker/tools/carry" "$ROOT/apps/worker/src" 2>/dev/null || true)"
if [ -n "$writers" ]; then
  echo "FAIL: the carry tooling contains a write to the old table, so the old stack is a rollback target:" >&2
  echo "$writers" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. The greenfield roots never address the old state.
# ---------------------------------------------------------------------------
if grep -rInE '^[^#]*cloud/(terraform|delegated-worker)' "$ROOT/infra/roots" >/dev/null 2>&1; then
  echo "FAIL: a greenfield root points at a legacy state key" >&2
  exit 1
fi
rehearsal_log "the greenfield roots name no legacy state key"

# ---------------------------------------------------------------------------
# 3. The export refuses a post-watermark write. A rehearsal with no such write in the
#    source table would pass this trivially, so the absence of one is a failed setup.
# ---------------------------------------------------------------------------
rehearsal_log "asserting the export refuses a table with a write after the watermark"
if rehearsal_dry_run; then
  rehearsal_plan "fss carry export --watermark <instant> --source <old table> -> expect refusal post_watermark_write"
  printf '{"refused":"post_watermark_write","post_watermark_writes":1}\n' > "$REPORTS/carry-watermark.json"
else
  set +e
  fss carry export --watermark "${FSS_CARRY_WATERMARK:?the drill must set the watermark it is testing}" \
    --source "${FSS_CARRY_SOURCE_TABLE:?the drill must name the old table}" \
    --report "$REPORTS/carry-watermark.json"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "FAIL: the export accepted a table with a post-watermark write" >&2
    exit 1
  fi
fi
python3 - "$REPORTS/carry-watermark.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report.get("post_watermark_writes", 0) >= 1, (
    f"there was no post-watermark write to refuse, so the refusal was never tested: {report}"
)
assert report.get("refused") == "post_watermark_write", f"the export refused for another reason: {report}"
PY

rehearsal_write_report "carry-watermark.txt" "prefix=$PREFIX old_stack=read_only rollback_target=false"
rehearsal_log "Appendix G 20 complete"
