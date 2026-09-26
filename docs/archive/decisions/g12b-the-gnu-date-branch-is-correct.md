# The restore drill's GNU `date` branch is correct, checked rather than assumed

**Lane:** G12b · **File checked:** `infra/scripts/rehearsal-restore-drill.sh`. No change made.

G12's stand-down note flagged that the `dry-run` job of `greenfield-release.yml` takes
the GNU branch of `minus()` on the Linux runner, and that the branch had only ever been
exercised on BSD `date` locally. PR 147's CI was green, which is evidence but not
proof: the two branches produce a string either way, and a wrong one would be a
plausible-looking instant rather than an error.

```bash
minus() { # minus <seconds>
  if date -u -d "@0" >/dev/null 2>&1; then
    date -u -d "$RESTORE_TARGET - $1 seconds" +%Y-%m-%dT%H:%M:%SZ
  else
    date -u -j -v"-$1S" -f %Y-%m-%dT%H:%M:%SZ "$RESTORE_TARGET" +%Y-%m-%dT%H:%M:%SZ
  fi
}
```

Checked against GNU coreutils 9.10 (`gdate`, the same implementation a
`ubuntu-24.04` runner has) and against this Mac's BSD `date`, with
`RESTORE_TARGET=2026-09-20T12:00:00Z`:

| | detection `date -u -d "@0"` | `minus 3600` | `minus 600` |
|---|---|---|---|
| GNU 9.10 | exits 0, prints the epoch | `2026-09-20T11:00:00Z` | `2026-09-20T11:50:00Z` |
| BSD | exits non-zero, takes the other branch | `2026-09-20T11:00:00Z` | — |

Three things this confirms and one it does not.

* The **detection** discriminates. BSD `date`'s `-d` is the daylight-saving flag and
  rejects `@0`, so it falls through; GNU accepts it. A detection that passed on both
  would silently send BSD into the GNU branch.
* GNU's parser accepts the ISO 8601 instant with the `T` separator and the `Z`, and
  accepts ` - 3600 seconds` as a signed relative item after it. That combination is
  the part worth checking: GNU's date-string grammar is permissive in ways that are
  easy to be wrong about, and a form it could not parse would exit non-zero under
  `set -e` rather than produce a bad instant — but a form it parsed *differently*
  would not.
* Both branches agree to the second on the same input, which is what Appendix E steps
  2, 3 and 4 need: the replay window is "the restore point minus one hour" and the
  Sent search is "minus ten minutes", and a drill that measured either from the wrong
  instant would reconstruct the wrong interval and still report a pass.

What it does not confirm: the value of `RESTORE_TARGET` in a real run. In the dry run
it defaults to `DRILL_START`; in a credentialed run `FSS_RESTORE_TARGET` carries the
point-in-time the restore actually used, and whether that string is the format this
function parses is settled by the first real drill. Appendix D is explicit that Gmail
recovery queries use epoch seconds "never ambiguous date strings"; these two are
report boundaries rather than query bounds, so a fixed ISO instant in UTC is within
the rule, but it is the one remaining assumption in this function.
