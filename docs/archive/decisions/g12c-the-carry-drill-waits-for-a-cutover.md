# The carry drill waits for a cutover, and says so in the release record

**Lane:** G12c · **Spec:** 17, Appendix G 20 · **Files:** `infra/scripts/{rehearsal-carry-watermark.sh,rehearsal-release-record.sh}`, `.github/workflows/greenfield-release.yml`, `test/release/scenario20.check.ts`, `docs/greenfield/release.md`

## What was wrong

The release workflow's carry step required two secrets that name things which do not
exist yet:

* `FSS_REHEARSAL_CARRY_WATERMARK` — the instant the cutover establishes as the old
  stack's last write;
* `FSS_REHEARSAL_CARRY_TABLE` — the old stack's table the carry reads.

Neither exists until a cutover is scheduled, and the first release comes **before** the
cutover. The script used `${FSS_CARRY_WATERMARK:?...}`, so the step would have failed
the run — and steps 10 and 11 would have run and no record would have been written,
which is the design working correctly against a precondition nobody could satisfy.

The two ways out that were rejected:

* **Invent values.** A drill against a made-up watermark and a table that is not the old
  stack's refuses for a made-up reason, and the release record then says Appendix G 20
  passed. That is the exact vacuous pass scenario 20 exists to prevent.
* **Make them static secrets with placeholder values.** Same failure, with a longer
  half-life: the placeholder would still be there at the real cutover.

## The decision

Appendix G 20 has two halves and only one of them needs a cutover.

**The half that is a property of this repository runs on every release**, watermark or
no watermark: the carry tooling contains no writer to the old table (`grep` for
`PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem` across
`apps/worker/tools/carry` and `apps/worker/src`), and no greenfield root names a legacy
state key. Those are what make "the old stack is not a rollback target" true, and they
are checkable today.

**The half that needs a cutover skips, loudly and in exactly one line.** When *both*
variables are absent the step prints

```
carry drill skipped: no cutover watermark yet
```

writes `carry_drill=skipped_no_watermark` into its own report, and exits 0.

**When only one is set the step fails.** Half a configuration is somebody halfway
through something, and the failure mode a skip must never cover is "the operator set
the watermark and forgot the table, and the drill silently did nothing".

**The release record carries the drill's own word.**
`rehearsal-release-record.sh` reads `carry-watermark.txt` and emits
`"carryDrill": "ran"` or `"carryDrill": "skipped_no_watermark"`, and **refuses** a
report that says neither — a report from a script this one no longer understands is not
a state to guess about. So an admin reading the record at enable time can see that the
export half was not exercised, rather than inferring a pass from the scenario being
listed.

## How the skip is stopped from becoming an accident

A skippable step is a step that can be skipped by accident. Four things close that:

1. The skip is only legal when **both** variables are absent.
2. The record names the state; it does not omit it. `carryDrill` is a required field.
3. The half of scenario 20 that needs no cutover still runs in the skip branch, and
   `scenario20.check.ts` asserts it by running the script and looking for the writer
   check's own output — not by reading the source, which would pass against a check
   somebody had commented out.
4. **The dry run exercises both branches.** The existing plan step sets both variables
   and reaches the export refusal; a new step unsets both and requires the skip line,
   the report, the `carryDrill` field in a real record, and a refusal for each half
   configuration. Both run on every pull request, with no credential.

`scenario20.check.ts` runs the scripts rather than reading them: four cases on the
drill (skip, writer check during the skip, two half configurations, the full run) and
two on the record. Nine assertions in the file now, where three were static.

## After the cutover

Set both secrets, and nothing else changes: the step runs the drill it always would
have, the report says `carry_drill=ran`, and the record says so. `release.md` 1.3 marks
the two secrets optional until then, and this paragraph is the instruction for the day
they stop being optional.
