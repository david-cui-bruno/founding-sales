# The data carry: moving the old table into PostgreSQL

**This page is a directive.** It is the list of commands David runs, in order, to
move firms, evidence, every suppression and the template bodies out of the old
DynamoDB table and into the new database. Specification revision 3, section 2 "Data
carry", section 17, and Appendix G 20.

Nothing in it contains a key, a token, a password or a connection string, and nothing
it asks you to run will print one. If a step's output contains a firm name, a phone
number or an address, that is a defect — stop and report it.

## Before you start

**The rollback statement, and it is the whole of the rollback plan.** From step 2
onwards the old stack is **read-only**. It is not a rollback target and it is never
switched back to. If the carry goes wrong, the recovery is a PostgreSQL restore under
Appendix E's post-restore protocol and another carry — never re-enabling the old
worker's schedule. Section 4.2: "the old stack is never a rollback target." The
export can only read: `OldTableReader` has one method, there is no put, delete or
transact anywhere in `apps/worker/tools/carry`, and a test asserts that surface.

**What you need in front of you.**

| | |
|---|---|
| A terminal in the repository checkout, with a full install | `export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"`, then `npm install --ignore-scripts --no-audit --no-fund` if you have not already. The two AWS SDK packages the carry loads are devDependencies of `@fss/worker`, so a full install has them and the worker image does not. |
| AWS credentials for the **operator** role | read on the old table, write on the suppression journal bucket. Not the API task role, not the worker task role. |
| The `age` binary | `age --version` should answer |
| Your age **recipient** (public key) | it may be written down; it is public |
| The removable volume holding your age **identity** | mounted only for steps 6 and 7, unmounted after |
| A scratch directory **outside** this repository | e.g. `~/carry-2026-09-21`. The artifact never enters the checkout, and `.gitignore` is not what protects it — the path is. |

Set two shell variables so the commands below read cleanly. Neither is a secret.

```
CARRY=~/carry-2026-09-21          # outside the repository
ID=carry-2026-09-21               # the artifact id; it appears in the audit rows
mkdir -p "$CARRY" && chmod 700 "$CARRY"
```

The database connection string is passed **by the name of an environment variable**,
never as an argument, because an argument list is visible in `ps` and ends up in a
shell history file. Export it once, in this shell only:

```
read -rs FSS_CARRY_DATABASE_URL && export FSS_CARRY_DATABASE_URL
```

---

## 1. Prove the new stack is ready to receive

```
npm run gate:greenfield
```

**Good result:** the gate passes. If it does not, stop; there is no point carrying
data into a build that does not pass its own tests.

Check that the API and worker are running against the schema they expect, and that
sending is still disabled (section 16.2: production sending stays off until the
release gate and an explicit admin enable). The carry does not turn sending on and
must not be run on a day you intend to turn it on.

## 2. Establish the write watermark

In the AWS console, **disable the old worker's EventBridge schedule rule.** Note the
exact instant you did it, from the console's own confirmation.

Then write the flag file. The export refuses to run without it, and there is no
override:

```
cat > "$CARRY/watermark.json" <<'JSON'
{
  "schema": "fss.carry.watermark.v1",
  "disabledAt": "2026-09-21T13:00:00.000Z",
  "scheduleRuleName": "PUT-THE-RULE-NAME-HERE",
  "recordedBy": "operator"
}
JSON
```

Replace `disabledAt` with the real instant in UTC and `scheduleRuleName` with the
rule you actually disabled. Both matter: "I disabled the schedule" and "I disabled
*that* schedule" are different claims, and only the second can be checked against the
console afterwards.

**Good result:** the rule shows as disabled in the console, and the file names the
same rule.

**From this instant the old stack is read-only.** Do not open the old Mac app, do not
re-enable the rule, and do not run any old operator command that writes.

**This instant is also the rehearsal's watermark.** Until you have it there is nothing
for the rehearsal's carry drill to exercise, so the two `rehearsal` environment secrets
`FSS_REHEARSAL_CARRY_WATERMARK` and `FSS_REHEARSAL_CARRY_TABLE` do not exist yet and the
drill prints `carry drill skipped: no cutover watermark yet` — the release record says
`"carryDrill": "skipped_no_watermark"` rather than claiming a pass. Once you have the
instant above and the old table's name, set both secrets; from the next rehearsal the
drill runs. Set one without the other and the step fails on purpose. See
`docs/decisions/g12c-the-carry-drill-waits-for-a-cutover.md` and `release.md` 1.3.

## 3. Wait five minutes, then confirm the old worker has stopped

Watch the old worker's log group. **Good result:** no new invocation after the
watermark instant. A late invocation means the rule was not the only trigger; find
the other one, disable it, and update `disabledAt` before continuing. The export will
refuse anyway — it fails with `post_watermark_items_present` if it finds a record the
old table wrote after the watermark — but finding out here is cheaper.

## 4. Export, under the operator role

```
node --experimental-transform-types apps/worker/tools/carry/main.ts export \
  --watermark "$CARRY/watermark.json" \
  --out "$CARRY/$ID.fss-carry" \
  --receipt "$CARRY/$ID.receipt.json" \
  --table PUT-THE-OLD-TABLE-NAME-HERE \
  --old-workspace PUT-THE-OLD-WORKSPACE-ID-HERE \
  --region us-east-1 \
  --recipient PUT-YOUR-AGE-RECIPIENT-HERE \
  --artifact-id "$ID"
```

Runs as: the **operator** role, on your laptop. It reads the old table and writes two
files into `$CARRY`. It writes nothing to AWS and nothing to the database.

**Good result:** an exit status of 0 and a table like this, with four counts and four
digests:

```
artifact      carry-2026-09-21
watermark     2026-09-21T13:00:00.000Z
cipher        age
sealed bytes  184320
sealed sha256 <64 hex characters>
manifest      <64 hex characters>
firm          412  <64 hex characters>
evidence      388  <64 hex characters>
suppression    37  <64 hex characters>
template        5  <64 hex characters>
```

Write the four counts down. Step 7 has to produce the same four.

**If it refuses**, the reason is one word and it means:

| Reason | What to do |
|---|---|
| `watermark_absent`, `watermark_unreadable`, `watermark_schema_unknown` | the flag file in step 2 is missing or malformed |
| `watermark_instant_invalid`, `watermark_schedule_unnamed` | `disabledAt` or `scheduleRuleName` is empty or not an instant |
| `watermark_in_future` | the instant you wrote has not happened yet; check the time zone |
| `post_watermark_items_present` | the old stack wrote after the watermark. Go back to step 3. Do not adjust the watermark to hide it. |
| `record_unreadable` | a record in the old table is not a shape the reader knows. Report it with the counts; it needs a code change, not a workaround. |

No artifact is written when it refuses. There is nothing to clean up.

## 5. Move the artifact to the volume you will import from

Copy `$CARRY/$ID.fss-carry` and `$CARRY/$ID.receipt.json` to the machine that can
reach the database, if it is not this one. The receipt holds only counts and digests
and is safe to keep afterwards; the artifact is prospect data and is shredded in step
9.

**Good result:** on the receiving machine,

```
shasum -a 256 "$CARRY/$ID.fss-carry"
```

matches `sealed sha256` in the receipt.

## 6. Verify the artifact before you import it

Mount the volume holding your age identity.

```
node --experimental-transform-types apps/worker/tools/carry/main.ts verify \
  --artifact "$CARRY/$ID.fss-carry" \
  --receipt "$CARRY/$ID.receipt.json" \
  --identity /Volumes/PUT-YOUR-VOLUME-HERE/identity.txt
```

**Good result:** exit status 0, and counts identical to step 4.

`artifact_digest_mismatch` means the file changed in transit — copy it again.
`manifest_digest_mismatch` means the receipt and the artifact are from different
exports. `artifact_unreadable` means the identity does not open it.

## 7. Import

```
node --experimental-transform-types apps/worker/tools/carry/main.ts import \
  --artifact "$CARRY/$ID.fss-carry" \
  --receipt "$CARRY/$ID.receipt.json" \
  --identity /Volumes/PUT-YOUR-VOLUME-HERE/identity.txt \
  --workspace PUT-THE-NEW-WORKSPACE-UUID-HERE \
  --database-url-env FSS_CARRY_DATABASE_URL \
  --journal-bucket PUT-THE-SUPPRESSION-JOURNAL-BUCKET-HERE \
  --region us-east-1
```

Runs as: the **operator** role for the journal bucket, and the application database
role for PostgreSQL. The whole import is one transaction: if anything refuses,
nothing is written.

**The single-salesperson shortcut.** By default every carried firm arrives
**unassigned**, and an admin assigns them in the CRM. While Callie has one
salesperson that is four hundred clicks for a foregone conclusion, so you may add:

```
  --assign-to-user PUT-THE-SALESPERSON-USER-UUID-HERE
```

It assigns every firm *this run creates* to that user, refuses with
`assignee_unknown` before writing anything if they are not an active member of the
workspace, and records the id in the carry audit row. It does not touch a firm a
previous run already carried: changing an assignment is `reassignFirm`, which is
admin-only and opens a `reassignment` hold, and the carry has no business doing that
behind your back. Leave the flag off the moment there is a second salesperson.

**Good result:** exit status 0 and `parity matched`, with `missing 0`, `unexpected 0`
and `hash-mismatch 0` on every line:

```
artifact   carry-2026-09-21
watermark  2026-09-21T13:00:00.000Z
firms      created 412  reused 0
evidence   created 388  reused 0
routes     created 690  refused 4
suppress   created 37  reused 0
templates  created 0  deferred 5
assigned   <the user id, or "nobody (the admin assigns in the CRM)">
parity     matched
```

Three lines of that are expected to look odd and are correct:

* **`refused 4` on routes.** A carried number or address the greenfield validators
  refuse is reported and the firm is carried without it. A route is recoverable by
  hand from the evidence; a firm dropped from the carry is not. Every carried route
  arrives as a `candidate`, never as something dialable.
* **`deferred 5` on templates.** The template bodies are read, counted and checked
  for parity, but not written: `template_versions` arrives with migration 0009. Until
  then re-enter the five templates by hand in the new system and approve them there.
  The old approvals were void under the new footer rule anyway. See
  `docs/decisions/g11-template-importer-seam.md`.
* **Nothing about postures.** Postures are never copied (section 2). Record the state
  postures you intend to call under deliberately, in the new system, with their
  sources and review dates.

Running this command twice is safe and is the recommended way to confirm it: the
second run reports `created 0 reused N` on every line, `parity matched`, and changes
nothing.

**If it refuses:**

| Reason | Meaning |
|---|---|
| `post_watermark_record` | the artifact holds a record written after its own watermark. The artifact is wrong; go back to step 3. |
| `assignee_unknown` | `--assign-to-user` named someone who is not an active member of this workspace. Nothing was written. |
| `parity_mismatch` | the counts or hashes disagree. The transaction rolled back; report the per-kind table. |
| `suppression_firm_absent` | a firm-scoped suppression named a firm that did not come over. Nothing was written. Report it. |
| `firm_refused`, `evidence_refused`, `suppression_refused` | a domain command refused with a code; report the code. |

Unmount the identity volume now.

## 8. Read the parity report and confirm the four counts

Compare the four counts from step 4 with what step 7 reported, and check the
suppressions directly. In `psql`:

```
SELECT scope, count(*) FROM effective_suppressions
 WHERE workspace_id = 'PUT-THE-NEW-WORKSPACE-UUID-HERE' GROUP BY scope;
```

**Good result:** the total equals the `suppression` count from step 4, and every
carried event's `source` is `import`.

Then find the firms that arrived uncallable, which is expected and deliberate:

```
SELECT count(*) FROM firms
 WHERE workspace_id = 'PUT-THE-NEW-WORKSPACE-UUID-HERE' AND time_zone IS NULL;
```

Those are firms in a state that spans two time zones, or firms whose old record
carried no state at all. The old table's state-wide time zone is **not** carried,
because section 9.2 forbids the shortcut and a wrong zone is a call at the wrong
hour. Record an address for the ones you intend to call; see
`docs/decisions/g11-old-zone-is-not-a-recorded-zone.md`. Nothing else is blocked —
email windows, research and the Today list all work without it.

If you did not use `--assign-to-user`, assign the firms in the CRM now. Nothing
automated can run on an unassigned firm.

## 9. Shred the artifact, with its audit row

```
node --experimental-transform-types apps/worker/tools/carry/main.ts shred \
  --artifact "$CARRY/$ID.fss-carry" \
  --receipt "$CARRY/$ID.receipt.json" \
  --workspace PUT-THE-NEW-WORKSPACE-UUID-HERE \
  --database-url-env FSS_CARRY_DATABASE_URL
```

**Good result:** exit status 0, `shredded carry-2026-09-21`, and

```
SELECT action, detail->>'artifactId', detail->>'sealedSha256'
  FROM audit_events
 WHERE workspace_id = 'PUT-THE-NEW-WORKSPACE-UUID-HERE'
   AND action = 'carry.artifact_deleted';
```

returns exactly one row naming this artifact. The file is gone; `ls "$CARRY"` shows
only the receipt.

The bytes are overwritten before the file is unlinked, but on an SSD that is not a
guarantee the old blocks are physically unrecoverable, and this tool does not claim
it is. What protects the data is that the artifact was never in plaintext, that the
identity which opens it is unmounted, and that the file is gone. Keep the receipt: it
is counts and digests only, and it is what proves a year from now which artifact was
deleted.

## 10. Close the old stack

The old EventBridge rule stays disabled permanently. The old table stays in place,
read-only, until a later lane deletes the old trees; it is **not** a rollback target
and it is never switched back to. New activity — sends, replies, suppressions —
happens only in the new stack from the watermark onwards, and nothing ever flows back
(Appendix G 20).

If a suppression is discovered later that the carry did not bring over, record it in
the new system as an ordinary suppression. Do not go back to the old table for it.

---

## What the carry moved, in one table

| Kind | Old sort key | Where it lands | State on arrival |
|---|---|---|---|
| Firms | `FIRM#`, and `ACCOUNT#` where no `FIRM#` exists | `firms`, with the old id in `record_aliases` | unassigned unless `--assign-to-user`; zone only where the versioned rule establishes it |
| Routes | on the firm record | `phone_routes`, `email_addresses` | `candidate`, `source = 'import'` |
| Evidence | `EVIDENCE#` | `evidence_items`, one row per source | provider `legacy_research`, URL, sha256 and excerpt preserved |
| Suppressions | `SUPPRESS#FIRM#`, `SUPPRESS#<handle>` | `suppression_events`, journalled first | `source = 'import'`, terminal immediately |
| Templates | `TEMPLATE#` | **not yet** — read and counted only | see step 7 |
| Postures | — | **never copied** | record them deliberately |
| Enrollments, sequences, counters, grants, events | — | **never copied** | the new system starts its own |
