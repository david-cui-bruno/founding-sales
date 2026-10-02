#!/usr/bin/env bash
# A manual sweep of a trial review folder (slice S3T-E, TE design reset). review.mjs removes the
# export itself on every exit and writes no plaintext, so this is only for leftovers: every export
# file (trial-export*), verdicts.json, and any trial-calls.json an older version wrote.
# reasons-for-david.txt (David's notes) is removed only with --all. Lists the folder afterwards.
#
#   bash tools/trial-review/cleanup.sh <folder> [--all]
set -euo pipefail
folder=${1:?usage: cleanup.sh <folder> [--all]}
all=${2:-}
[ -d "$folder" ] || { echo "cleanup: no folder $folder" >&2; exit 2; }
if [ -n "$all" ] && [ "$all" != "--all" ]; then echo "usage: cleanup.sh <folder> [--all]" >&2; exit 2; fi
shopt -s nullglob
targets=("$folder"/trial-export* "$folder/verdicts.json" "$folder/trial-calls.json")
if [ "$all" = "--all" ]; then targets+=("$folder/reasons-for-david.txt"); fi
removed=0
for file in "${targets[@]}"; do
  if [ -e "$file" ]; then
    rm -f -- "$file"
    removed=$((removed + 1))
  fi
done
echo "cleanup: removed $removed file(s) from $folder; it now holds:"
ls -la -- "$folder"
for file in "${targets[@]}"; do
  if [ -e "$file" ]; then echo "cleanup: $file is still there" >&2; exit 1; fi
done
