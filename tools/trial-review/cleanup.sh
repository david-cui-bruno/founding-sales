#!/usr/bin/env bash
# Remove the decrypted trial calls and the export from a review folder (slice S3T-E), then list
# the folder to show they are gone. review.mjs runs this at the end, success or failure, unless
# --keep. verdicts.json (ids, verdicts and quote-checked reasons) stays.
#
#   bash tools/trial-review/cleanup.sh <folder>
set -euo pipefail
folder=${1:?usage: cleanup.sh <folder>}
[ -d "$folder" ] || { echo "cleanup: no folder $folder" >&2; exit 2; }
shopt -s nullglob
removed=0
for file in "$folder/trial-calls.json" "$folder"/trial-export*; do
  if [ -e "$file" ]; then
    rm -f -- "$file"
    removed=$((removed + 1))
  fi
done
echo "cleanup: removed $removed file(s) from $folder; it now holds:"
ls -la -- "$folder"
leftover=("$folder/trial-calls.json" "$folder"/trial-export*)
for file in "${leftover[@]}"; do
  if [ -e "$file" ]; then echo "cleanup: $file is still there" >&2; exit 1; fi
done
