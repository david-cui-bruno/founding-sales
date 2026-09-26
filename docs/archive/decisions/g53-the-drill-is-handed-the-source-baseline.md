# The drill task is handed the source baseline as a value in its command (lane g53)

**Lane:** g53 · **Date:** 24 September 2026 · **Spec:** Appendix E steps 1 to 9, Appendix G 11 · **Evidence:** thirteenth full run, 8.0w of `docs/greenfield/release.md`

## What happened

The thirteenth full run started the drill task against a restored instance for the first
time. It exited 21 after about 25 seconds:

```
ENOENT: no such file or directory, open '/tmp/fss-drill/step0-baseline.json'
```

Two things were wrong. Nothing created the reports directory: the worker image makes
`/tmp` and nothing under it, and the drill task definition mounts nothing. And behind that
write was the wrong baseline. The rehearsal measures step 0 on the **source**, before the
restore, in a separate one-off task, and the answer comes back to the runner through that
task's log stream (`g12h-the-report-comes-back-in-the-log.md`). The drill was then launched
with `--as-of <restore target>` and no baseline, so it measured step 0 again on the
**restored** copy. "No suppression lost, no send repeated" would have been checked against
the database under test rather than against the one it was restored from.

## The decision

The runner hands the drill task the baseline as a value: `fss drill --baseline-json
'<json>'`.

* **It travels in the command override.** A Fargate task's filesystem is created with
  it, there is no shared volume and the drill role has no S3. Adding a bucket would be
  a new place prospect-shaped counts live, for the reasons g12h gives against one. The
  override is the one channel that already reaches the task.
* **An argument, not an environment variable.** `rehearsal-run-task.sh` forwards only
  the restored host as `--env`. Carrying the baseline that way would change the wrapper
  every one-off task shares, and a value the command consumes is an argument in every
  other sense. `release_run_task` JSON-encodes each command word, and the production-name
  refusal reads each one. Braces, quotes and colons survive both, and
  `test/release/scenario11.check.ts` drives the wrapper to show it.
* **One line, six fields.** The wrapper reads the command one word per line, so the
  runner compacts the JSON. It keeps `asOf` and the five counts, which is everything the
  drill and step 8 read. The override then stays the same size however many workspaces
  the rehearsal has. All six are public, so `describe-tasks` and the logs may show them.
  A baseline with no `asOf` is refused on the runner, before the restore is requested.
* **The file still exists inside the task.** The drill writes the value to
  `<reports>/step0-baseline.json` and uses that path as step 8's `--before`. Step 8 is
  unchanged, and the report directory reads the same whichever form step 0 came from.
* **Exactly one source.** `--baseline`, `--as-of` and `--baseline-json` are a `oneOf`,
  so the grammar refuses any two. `--as-of` is not needed beside a baseline, because it
  is only the instant a measured baseline is taken at. `--from` and `--since` default to
  offsets from the baseline's own `asOf`. `--as-of` stays for an operator drilling an
  already-restored instance by hand, as the weaker form.

The drill creates its reports directory, recursively and with mode 700, before its first
write. If it cannot, it refuses `reports_unwritable` and names the directory, rather than
throwing.
