#!/usr/bin/env bash
# A manual sweep of a trial review folder (slice S3T-E). review.mjs removes the export itself on
# every exit and writes no plaintext and no free text, so this is only for leftovers: every export
# file (trial-export*), verdicts.json, and the trial-calls.json and reasons-for-david.txt that
# earlier versions of the tool wrote. Lists the folder afterwards.
#
#   bash tools/trial-review/cleanup.sh <folder>
set -euo pipefail
[ "$#" -eq 1 ] || { echo "usage: cleanup.sh <folder>" >&2; exit 2; }
folder=$1
[ -d "$folder" ] || { echo "cleanup: no folder $folder" >&2; exit 2; }
shopt -s nullglob
targets=("$folder"/trial-export* "$folder/verdicts.json" "$folder/trial-calls.json" "$folder/reasons-for-david.txt")
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
