# FSS restore drill

**Lane:** G1 · **Spec:** Appendix E, steps 1 to 9; supported by sections 4.2, 10.2, 12.3 and 13.3 · **Where it runs:** the `rehearsal` root, never production.

Appendix E is the post-restore protocol. This document turns its nine steps into commands. It runs in an isolated rehearsal environment for any release that touches schema, sending, suppression, Gmail, restore or job fencing, and on a recurring operational drill schedule (spec 16.2, Appendix E closing paragraph).

The drill's purpose is not to prove a restore works. RDS point-in-time recovery works. The purpose is to prove that **after** a restore, FSS refuses to send or dial until every protected effect has been reconstructed, and that reconstruction is complete and countable.

Some steps are commands against AWS and Gmail; some are FSS admin commands. Every one marked **(FSS)** is `apps/worker/src/tools/fss.ts`, which lane G12g built to the shapes this document and `infra/scripts/rehearsal-restore-drill.sh` already asked for; `docs/greenfield/processes.md` has the two invocation forms (a `DATABASE_URL` locally, a command override of the worker image inside the VPC). The rehearsal uses the second form, and nothing is ever on a PATH.

In the rehearsal, `infra/scripts/rehearsal-restore-drill.sh` keeps the AWS calls on the runner and runs the database work as two one-off tasks inside the VPC. The first is `fss admin counts --as-of` for the baseline, on the source, before the restore. Its answer comes back through the task's log stream to the runner, where the step 0 refusal reads it. The second is one `fss drill` against the restored instance for steps 1 to 9, which runs them in one process and writes one JSON report per step.

**The drill task is handed that baseline as a value: `fss drill --baseline-json '<json>'`** (lane g53, `docs/decisions/g53-the-drill-is-handed-the-source-baseline.md`). A one-off task's filesystem is created with it, there is no shared volume and the drill role has no S3, so its command override is the only thing that reaches it. The runner compacts the baseline to one line holding its `asOf` instant and the five counts, all public, and refuses a baseline with no instant before the restore is requested. The drill writes the value to `step0-baseline.json` in its reports directory, which it creates itself with mode 700, and reads that file as step 8's `--before`. Every "no suppression lost, no send repeated" comparison is therefore against the source as it stood at the restore target. Until lane g53 the drill task was launched with `--as-of` instead, measured step 0 again on the restored copy, and died writing it into `/tmp/fss-drill`, a directory nothing had created. The thirteenth full run stopped exactly there (`docs/greenfield/release.md` 8.0w). `--as-of` remains for an operator drilling an already-restored instance by hand, and it is the weaker form for that reason: it can only count what the restored copy holds.

## 0. Before you start

```bash
cd infra/roots/rehearsal
RUN_ID=<the run you are drilling>
export PREFIX="fss-rh-${RUN_ID}"
export AWS_REGION=us-east-1
```

Everything below addresses `$PREFIX`. If a command in this drill names a resource without `fss-rh-` in it, stop: you are pointed at the wrong environment.

Record the drill start instant in UTC. Every "restore point minus N" below is relative to the **restore target**, not to now.

```bash
export DRILL_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "drill start: $DRILL_START"
```

### 0.1 Create the evidence the drill has to reconstruct

A restore drill against an empty database proves nothing. Before taking the restore target, generate, in the rehearsal environment:

1. at least one **accepted send** (an `outbound_messages` fence that reached `sent`);
2. at least one **prospect reply** that set an opportunity manual;
3. at least one **prospect-originated opt-out** (journalled suppression);
4. at least one **salesperson manual suppression** inside its ten-minute window;
5. at least one ordinary **CRM edit** with no protected effect;
6. at least one applied **migration**.

Those six are what the baseline refusal below counts. They are not everything the steps after it need to find, and until lane g59 this section did not say so: the drill stopped at step 1 on every run, and would have stopped at steps 2, 3, 4, 8 and 9 in turn behind it (`docs/greenfield/release.md` 8.0s, 8.1). The full list, every prerequisite produced through the domain's own entry point and none by an `INSERT`:

| Step | What it has to find | What produces it | When |
|---|---|---|---|
| 1, dial probe | an assigned firm with a usable **phone** route, **and** a verified, enabled **calling identity** owned by that firm's assignee | the route: `addPhoneRoute`. The identity: `registerCallingIdentity`, then `verifyCallingIdentity` in the rehearsal admin's own scope, the attestation a person makes on the Settings screen (lane g60) | `before` |
| 2 | a journalled suppression the restore **loses** | a second prospect opt-out, ingested by the mail pipeline (`processMessageIds`), journalled before its row | `after` |
| 3 | a fence in `dispatching` or `reconciling`, started no earlier than the target minus ten minutes, whose Message-ID the Sent folder holds | one send through `dispatchOutboundMessage` against a recorded Gmail that delivers it and loses the response (Appendix B's fifth scenario), leaving the fence `reconciling` | `in-flight`, just before the target |
| 4 | an inbox message the restore lost, from a prospect the restored copy knows | the same late opt-out: its reply-lane entry is the reply effect step 4 counts, its firm and handle suppressions the opt-out effects; its firm and contact are made in `before` | `after` |
| 3, 4, 6 | a mailbox the drill task can read | the environment's KMS envelope key on the recorded seam, and the mailbox recording each phase reports (below) | every phase |
| 8 | the counts at the moment of failure | `fss admin counts` on the source after the `after` phase, handed to the drill as `--at-failure-json` | after `after` |
| 9 | a hold other than the restore holds, in force immediately before the advance; an active admin to attribute the advance to | an administrative pause through `openPause`; the workspace admin the seed acted as, handed to the drill as `--admin-user` | `before` |

**Step 1's dial probe has a subject (lane g60).** A calling identity is "a verified Callie outbound number" (9.1). Until lane g60 no path could verify one, so the probe refused `no_dialable_subject` and the drill recorded step 1 as **unanswered** (lane g59). Now a salesperson registers their own number and attests that it is the one they place calls from (`docs/decisions/g60-calling-identities-are-attested-in-version-one.md`). The seed's `before` phase does exactly that for the rehearsal admin, through the same two domain functions and in the admin's own scope, with the fictional number `+16175550143`. The row is recorded as an `owner_attestation` by the admin, with the instant. It is not an `INSERT` of a verified row, which migration 0016's `calling_identities_verification_recorded` would refuse anyway. So the restored copy holds a firm assigned to the admin, a usable phone route on it, and the admin's attested number, and the probe asks `authorizeDial` a real question.

**Refused is not enough.** `authorizeDial` stops at its first refusal, and the restore hold is its eighth step. The evidence firms' state (MA) has no posture in a rehearsal, so the probe is refused `posture_missing` at step 6 whether or not a restore is in progress, or `outside_calling_window` at step 7 at night. So step 1 also requires **`restore_in_progress` among the holds that apply to that same dial**. `dial-authorize` reports them beside its decision. The drill's `dialProbeFailure` and the runner's verdict both assert it, so the refusal is one the restore would have made on its own.

**Without a subject the step is still unanswered.** A database with no attested number — a production restore where nobody has added one, or a rehearsal whose seed did not run — gets the lane g59 treatment unchanged. The probe refuses `no_dialable_subject` and names the half it lacks. The drill records the step as failed and unanswered, runs every step after it, and still fails. The runner refuses any report with an unanswered step, and no release record is written. A dial that was *authorized* stops the drill where it happens, as it always did.

**The mailbox, across tasks.** Each phase and the drill are separate one-off tasks, and two things the drill shares with the seed do not survive a process by themselves. Each is handed over rather than faked:

* *the envelope key.* A recorded deployment used to wrap refresh tokens under a master key made per process, so the drill could not unwrap the token the seed stored. A task that carries `FSS_ENVELOPE_KEY_ID` — every deployed rehearsal task does — now wraps through the production KMS wrapper under the encryption context `fss_envelope_seam = recorded`, and labels the row's key id `recorded-seam:<key>`. A live process names the bare key and asks KMS with no context, so it refuses such a row twice over. The drill task role gets `kms:Decrypt` under that context only, and only outside production (`infra/modules/cluster`, `drill_unwraps_recorded_envelopes`). A task without the variable — a laptop, a test — keeps the per-process key;
* *the mailbox itself.* A recorded Gmail lives in the process that built it. Each phase's JSON report carries what its recorded mailbox holds — the Sent folder it delivered into and the inbound messages it delivered — and the runner merges the three reports and hands the drill `--mailbox-recording-json`. The drill's mail steps run against a recorded client built from that. Nothing in it is a credential, and nothing in it comes from the restored database.

In a deployed environment one command, in three phases, produces all of it (lanes g40 and g59). The first:

```bash
# (FSS) the six kinds, and what steps 1, 4 and 9 need to find later, idempotently
fss admin drill seed-evidence --workspace-slug rehearsal --phase before --report /tmp/evidence-before.json
```

It creates a fixed, recognisable firm, contact, route and opportunity under
`drill-evidence.invalid`, and a sending domain through `registerSendingDomain`; drives
one outbound fence through the real dispatch path against the recorded Gmail client
until its state is `sent`; ingests a prospect reply and a prospect-originated opt-out
through the same pipeline the mail sync runs, so the reply's confirmation sets the
opportunity manual and the opt-out's suppression is journalled before its row; records
a salesperson's own manual suppression, whose ten-minute correction window is still
open when the drill runs minutes later; makes one ordinary CRM edit; and makes what the
later steps need to find: the firm whose opt-out arrives after the target, a usable
phone route, the admin's own calling number registered and attested through the domain
(lane g60), and an administrative pause. Each item is reported `created` or
`existing`, and the report carries the same five counts `fss admin counts` reports —
it calls the same code, so the numbers cannot drift from the ones the refusal below
reads — along with the workspace admin it acted as and its mailbox recording. A second
run of any phase adds nothing and reports the same recording.

The release runs this phase for you: `.github/workflows/greenfield-release.yml` has a
`Create the evidence the drill has to reconstruct` step between the workspace bootstrap
and the schema ranges, which launches
`infra/scripts/release-seed-drill-evidence.sh … --phase before` on the operations task
definition. `infra/scripts/rehearsal-restore-drill.sh` runs the other two, each where
this document puts it.

**Production is never seeded.** Section 7 of the runbook drills production against real
data, and the sends, replies and suppressions it reconstructs are a salesperson's — a
fixture in their place would replace the thing being proved. Two guards say so and
neither depends on the other: the command refuses unless `FSS_DEPENDENCIES` is exactly
`recorded`, which production's worker never is, and
`release-seed-drill-evidence.sh` refuses any prefix that is not `fss-rh-<run>` with no
flag that relaxes it.

Then leave one send in doubt, and read the restore target — **RDS chooses it, you do not**:

```bash
# (FSS) one send delivered whose response was lost: the fence step 3 reconciles
fss admin drill seed-evidence --workspace-slug rehearsal --phase in-flight --report /tmp/evidence-in-flight.json
# ... wait until LatestRestorableTime is later than that report's asOf, then:
export RESTORE_TARGET=$(aws rds describe-db-instances --db-instance-identifier "${PREFIX}-pg" \
  --query 'DBInstances[0].LatestRestorableTime' --output text | sed -E 's/\.[0-9]+//; s/\+00:00$//')Z
echo "restore target: $RESTORE_TARGET"
```

The send goes first, the wait second and the target third, because step 3 looks only at
fences started from the target minus ten minutes: the fence has to be in the restored
copy and inside that window. The latest restorable point lags real time, so the drill
script **waits** for RDS to report a `LatestRestorableTime` later than the newest
evidence instant — the in-flight report's `asOf`, or the before report's where somebody
else seeded — before it reads the target at all. Without that wait the target would
predate the evidence, the restore would land on a database that has none of it, and the
refusal below would fire with the seeding having run and worked.

`date -u` used to stand here and it was wrong: the latest restorable point lags real time by up to about five minutes (spec 4.1), so "now" is an instant the instance cannot be restored to and `--restore-time` refuses it with `InvalidRestoreTime`. The restore below therefore asks for `--use-latest-restorable-time` and the baseline is measured at the instant RDS reported a moment earlier. Reading it first and restoring second can only mean the restored database holds slightly *more* than the baseline counted, which is the safe direction: every assertion below is "no suppression lost, no send repeated" against a floor. It is also why the work the restore is meant to lose is written only **once the restore has been requested** (step 1), and not between the baseline and the request as it was until lane g59: activity in that gap may or may not be in the restored copy, and only a point RDS had not reached when it was asked certainly is not.

Record the counts you expect to survive:

```bash
# (FSS) reconciliation baseline, on the source, at the target
fss admin counts --as-of "$RESTORE_TARGET" > /tmp/before.json
```

The counts at the moment of failure come in step 1, after the work the restore loses.

## Step 1. Restore, and prove the generation mismatch holds sending and dialing

> *Appendix E.1: the restored database's `system_generation` differs from the operator-controlled expected generation; restore holds block sending and dialing.*

Restore to a new instance. Never restore over the live identifier.

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "${PREFIX}-pg" \
  --target-db-instance-identifier "${PREFIX}-pg-restored" \
  --use-latest-restorable-time \
  --db-subnet-group-name "${PREFIX}-db" \
  --vpc-security-group-ids "$(terraform output -json security_group_ids | python3 -c 'import json,sys; print(json.load(sys.stdin)["database"])')" \
  --no-publicly-accessible \
  --db-parameter-group-name "${PREFIX}-pg16"
```

**As soon as the restore has been requested**, write the work it is meant to lose, and count the source at the moment of failure (lane g59):

```bash
# (FSS) on the source: a late prospect opt-out, a second accepted send, a second CRM edit
fss admin drill seed-evidence --workspace-slug rehearsal --phase after --report /tmp/evidence-after.json
# (FSS) on the source: the counts at the moment of failure, which step 8 compares against
fss admin counts > /tmp/at-failure.json

aws rds wait db-instance-available --db-instance-identifier "${PREFIX}-pg-restored"
```

`--phase after` adds one of each thing a real outage loses. The opt-out is what steps 2
and 4 reconstruct: the restore loses its row, step 2 replays its suppression from the
journal, and step 4 recovers the message from the inbox and reapplies its effects. Its
suppressions' command ids are keyed on the provider's message id rather than the row's,
so the event step 4 derives on the restored copy is the one step 2 replayed, not a
second one that the drill task, which cannot append to the journal, would have to
write. The send and the edit are lost with it; the edit is step 8's RPO, and the send
is the case step 3 does not yet cover (below). Until lane g59 this phase added only the
send and the edit and ran between the baseline and the request, so step 2 had nothing to
replay, and the send could land on either side of the point RDS chose.

Note the actual restorable point RDS used. It may lag the requested target by up to about five minutes (spec 4.1), and that lag is part of what the drill measures:

```bash
aws rds describe-db-instances --db-instance-identifier "${PREFIX}-pg-restored" \
  --query 'DBInstances[0].{restored:InstanceCreateTime,latestRestorable:LatestRestorableTime}'
```

**Hold the restored instance before anything is pointed at it** (lane g56). A restored copy carries its source's `system_generation`, and only step 9 moves a generation, so the copy looks restored only to a check that expects a generation *ahead* of it. Read the copy's generation R (`fss admin counts` or `fss verify` on the operations task with `FSS_DATABASE_HOST` overridden to the restored endpoint: `systemGeneration`), then run the worker's own startup check against it by hand:

```bash
# (FSS) on the operations task definition, FSS_DATABASE_HOST = the restored endpoint.
# Opens one restore_in_progress hold per workspace and logs restore_generation_mismatch.
fss admin restore-holds open --expected-generation "$((R + 1))"
```

Then set the services' pin to the same number, `expected_system_generation = R + 1` in the root, **in the same apply as, or an apply before, whatever points the services at the restored instance — never after**. A worker that starts against the restored copy with the old pin sees no mismatch and holds nothing. With the new pin every worker start opens the holds again if they are gone (it never adds a second one) and raises the alarm. `docs/greenfield/release.md` 7.1 has the production commands. The automated drill does the same thing in one task: the runner hands `fss drill` the source baseline's `systemGeneration` plus one as `--expected-generation`, and step 1a runs `admin restore-holds open` with it.

Point the services at the restored instance and confirm the refusal:

```bash
# Repoint FSS_DATABASE_HOST at the restored endpoint, and set expected_system_generation, then:
aws ecs update-service --cluster "${PREFIX}-cluster" --service "${PREFIX}-api"    --force-new-deployment
aws ecs update-service --cluster "${PREFIX}-cluster" --service "${PREFIX}-worker" --force-new-deployment
aws ecs wait services-stable --cluster "${PREFIX}-cluster" --services "${PREFIX}-api" "${PREFIX}-worker"
```

**The assertion of this step.** The restored database carries the old `system_generation`; the operator-controlled expected generation has moved on. Everything that sends or dials must be held:

```bash
# (FSS) every automated step kind and every dial must refuse with a restore reason code.
fss admin holds list --reason restore_in_progress
fss admin dial-authorize --any   # expect: allowed=false, and restore_in_progress among the holds
```

The dial half needs a subject that could otherwise be dialed: an assigned firm with a
usable phone route whose assignee owns a verified, enabled calling identity. In a
rehearsal the seed's `before` phase makes one (0.1). In production it is whichever
salesperson has attested their number on the Settings screen. The step passes when the
dial is refused **and** `restore_in_progress` is among the holds that apply to it. A
refusal at an earlier step of 9.2 with no restore hold behind it says nothing about the
restore, and fails the step. With no subject at all the probe refuses
`no_dialable_subject` and says which half is missing, rather than calling a refusal for
a missing number a restore hold. The automated drill records `step1-dial-refused` as
unanswered and carries on so the later steps are measured, and the runner fails the
drill on it all the same.

And the alarm must have fired. This is the `restore_generation_mismatch` metric filter feeding the immediately-critical alarm. It is one datapoint of one at 60 s and treats missing data as not breaching, so a few minutes after the last mismatch line its *state* is OK again; read its history, which keeps the transition:

```bash
aws cloudwatch describe-alarm-history --alarm-name "${PREFIX}-restore-generation-mismatch" \
  --history-item-type StateUpdate --start-date "$DRILL_START" \
  --query 'AlarmHistoryItems[].HistorySummary'
# expect: "Alarm updated from OK to ALARM" (or from INSUFFICIENT_DATA)
```

`rehearsal-restore-drill.sh` asserts both halves straight after the drill, before it judges the report, whenever step 1a passed. The drill task's captured log must hold the `restore_generation_mismatch` line, and the alarm's history must show a transition to ALARM since the drill began (polled for up to five minutes).

If sending is **not** held at this point, stop the drill and fail the release. Nothing else in this document matters.

## Step 2. Replay the suppression journal from the restore point minus one hour

> *Appendix E.2: replay the suppression journal from the restore point minus one hour; insert every missing event idempotently.*

The journal is the one pre-acknowledgement write outside PostgreSQL, so it holds suppressions the restored database has lost. The worker task role has read on the bucket for exactly this.

```bash
export JOURNAL_BUCKET=$(terraform output -raw journal_bucket_name)
export REPLAY_FROM=$(python3 - <<'PY'
import datetime, os
target = datetime.datetime.strptime(os.environ["RESTORE_TARGET"], "%Y-%m-%dT%H:%M:%SZ")
print((target - datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)
echo "replaying journal from $REPLAY_FROM"

# What is in the journal for that window.
aws s3api list-objects-v2 --bucket "$JOURNAL_BUCKET" \
  --query "Contents[?LastModified>=\`${REPLAY_FROM}\`].[Key,LastModified]" --output table

# (FSS) idempotent replay. Deterministic event ids make a second run a no-op.
fss admin suppression-journal replay --from "$REPLAY_FROM" --report /tmp/journal-replay.json
```

Assertions:

- every event in the window exists in `suppression_events` after the replay;
- running the replay a second time inserts nothing (deterministic ids, insert-only table);
- a prospect-originated opt-out reconstructed by the replay is **terminal**, not correctable by a salesperson (Appendix G scenario 30);
- a manual suppression whose ten-minute window expired before the failure finalises terminally rather than reopening.

```bash
fss admin suppression-journal replay --from "$REPLAY_FROM" --report /tmp/journal-replay-second.json
python3 -c "import json;a=json.load(open('/tmp/journal-replay-second.json'));assert a['inserted']==0, a"
```

## Step 3. Reconstruct sends from every mailbox Sent folder

> *Appendix E.3: search every mailbox Sent folder from the restore point minus ten minutes for FSS Message-IDs; insert sent tombstones for missing fences.*

A send the restored database does not know about must never be sent again. The deterministic Message-ID is what makes this searchable.

```bash
export SENT_FROM=$(python3 - <<'PY'
import datetime, os
target = datetime.datetime.strptime(os.environ["RESTORE_TARGET"], "%Y-%m-%dT%H:%M:%SZ")
print((target - datetime.timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)

# (FSS) for every connected mailbox, Gmail search on rfc822msgid: for FSS ids,
# then insert a sent tombstone for any fence the restored database is missing.
fss admin mailbox reconcile-sent --since "$SENT_FROM" --all-mailboxes --report /tmp/sent-reconcile.json
```

The search uses `rfc822msgid:` on the sending mailbox, which needs `gmail.readonly`; `gmail.metadata` is insufficient (Appendix B).

Assertions:

- every send made after the restore point appears as a tombstone, and its enrollment does not re-dispatch it;
- a fence in `dispatching` at the moment of failure never returns to `prepared`;
- a fence whose Sent search finds nothing stays `reconciling` within its bounded 24-hour observation window rather than being resent.

```bash
python3 -c "import json;r=json.load(open('/tmp/sent-reconcile.json'));assert r['resent']==0, r"
```

What the command does in this build: it reconciles the fences the restored copy holds in
`dispatching` or `reconciling`, started since `$SENT_FROM`, against the Sent folder, and
tombstones each one the folder proves delivered. The drill measures that case with the
in-flight send (0.1): one fence, one tombstone, nothing resent. A send whose fence the
restored copy never had — the `after` phase's — has no row to tombstone, and inserting
one for it, the first assertion above, is not implemented (`docs/greenfield/release.md`
8.1). The drill does not claim it.

## Step 4. Reprocess every mailbox inbox from the same point

> *Appendix E.4: reprocess every mailbox inbox from the same point so replies, opt-outs, direct sends and bounces reapply their effects.*

```bash
# (FSS) bounded recovery sync using epoch-second after:/before: bounds,
# 500 ids per page, every page. Never an ambiguous date string (Appendix D).
fss admin mailbox recover --since "$SENT_FROM" --all-mailboxes --report /tmp/inbox-recover.json
```

Assertions, each of which is a spec invariant rather than a nicety:

- a confirmed human reply received after the restore point re-establishes `control_mode = manual` and terminally stops that firm's enrollments;
- an uncertain or ambiguous reply re-creates its active holds on every plausible opportunity;
- an explicit opt-out reapplies as a terminal suppression;
- a direct Gmail send to an automated firm switches it to manual;
- a bounce invalidates the prospect route frozen on the originating fence, never the reporting daemon's address;
- a reply just outside the nominal bounds is still caught, because the window starts before the restore point (Appendix G scenario 13).

## Step 5. Discard job state and rematerialise from business state

> *Appendix E.5: discard runnable job state and rematerialise from business state.*

The restored `jobs` rows describe a world that no longer exists: leases held by dead workers, `run_at` instants already passed, idempotency keys for work whose business effect has since been reconstructed. Jobs are derived state, so they are thrown away and rebuilt.

```bash
# (FSS) drop queued/running/retryable rows, keep dead jobs for the audit trail,
# then let the scheduler's next one-minute pass insert what is genuinely due.
fss admin jobs discard-runnable --report /tmp/jobs-discard.json
fss admin scheduler run-once --report /tmp/jobs-rematerialise.json
```

Assertions:

- no job survives holding a lease from before the restore;
- rematerialised jobs are idempotent under `UNIQUE(workspace_id, kind, idempotency_key)`;
- no rematerialised job takes an external action while a restore hold is in force. This is the step where a bug would send a duplicate email, so check the outbound fence counts before and after.

```bash
aws cloudwatch get-metric-statistics --namespace "FSS/${PREFIX}" --metric-name OldestRunnableJobAgeSeconds \
  --statistics Maximum --start-time "$DRILL_START" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --period 60
```

## Step 6. Renew every Gmail watch and prove coverage

> *Appendix E.6: renew every Gmail watch and prove coverage for every mailbox.*

```bash
# (FSS) re-issue users.watch against the environment's own Pub/Sub topic.
fss admin mailbox watch-renew --all-mailboxes --report /tmp/watch-renew.json
fss admin mailbox coverage --all-mailboxes --report /tmp/coverage.json
```

The coverage watermark is the instant through which every relevant message is known processed. The mailbox-health hold clears **only when the full interval is processed**, never after one successful API call (spec 4.2, 12.3).

```bash
python3 -c "
import json; c=json.load(open('/tmp/coverage.json'))
assert all(m['complete'] for m in c['mailboxes']), c
"
aws cloudwatch describe-alarms --alarm-names "${PREFIX}-gmail-watch-expiring" \
  --query 'MetricAlarms[0].StateValue'
# expect: OK once the watches are renewed
```

If this environment has `enable_gmail_push = false`, the watch step is exercised against the reconciliation path only, and the drill must say so in its report. A release that changes Gmail behaviour needs a rehearsal run with its own Google Cloud project and push enabled.

## Step 7. Reapply migrations and validate schema ranges

> *Appendix E.7: reapply schema migrations and validate service schema ranges if the restore predates a migration.*

```bash
# (FSS) forward-only. A restore is repaired forward, never with a down migration.
fss migrate status
fss migrate up --report /tmp/migrate.json

# Both binaries must accept the resulting schema version.
aws ecs describe-task-definition --task-definition "${PREFIX}-api" \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`FSS_SCHEMA_MIN`||name==`FSS_SCHEMA_MAX`]'
aws ecs describe-task-definition --task-definition "${PREFIX}-worker" \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`FSS_SCHEMA_MIN`||name==`FSS_SCHEMA_MAX`]'
```

Assertions:

- the restored schema version lands inside both declared ranges;
- a binary whose range excludes the schema refuses to serve rather than guessing (Appendix G scenario 22);
- nothing was repaired with a destructive down migration.

## Step 8. Produce reconciliation counts and unresolved exceptions

> *Appendix E.8: produce reconciliation counts and unresolved exceptions for operator review.*

```bash
# (FSS)
fss admin counts > /tmp/after.json
fss admin restore-report \
  --before /tmp/before.json \
  --at-failure /tmp/at-failure.json \
  --after /tmp/after.json \
  --journal /tmp/journal-replay.json \
  --sent /tmp/sent-reconcile.json \
  --inbox /tmp/inbox-recover.json \
  --out /tmp/restore-report.json
```

The report must answer, in numbers:

| Question | Expected |
|---|---|
| Suppressions before vs after | equal or greater. **Never fewer.** A lost suppression fails the drill. |
| Suppressions at failure vs after | equal or greater. A suppression acknowledged before the failure and not back after steps 2 and 4 fails the drill, even when the count is above the baseline. |
| Sends that repeated | **zero** |
| Fences left `reconciling` | listed by mailbox with their observation deadline |
| Fences left `unknown_terminal` | listed, each awaiting an admin delivered/skipped decision |
| Replies whose effects reapplied | equal to the replies in the window |
| Ordinary CRM edits lost | the accepted RPO. **Report it; do not hide it.** This is the one category the design accepts losing. |
| Ambiguous messages still held | listed; they must still be held, not silently resolved |
| Dead jobs | carried over, still visible to admins |

`--at-failure` is the source counted after the work the restore loses (step 1). With
it the report adds `at_failure_as_of`, `suppressions_at_failure`, `sends_at_failure`,
`replies_at_failure`, `crm_edits_at_failure`, `migrations_at_failure` and
`crm_edits_lost` — the edits at failure minus the edits after, a floor on the RPO in
edits beside `crm_rpo_seconds` — and step 9 refuses (`report_suppression_lost`) a report
whose `suppressions_after` is below `suppressions_at_failure`. There is deliberately no
"sends lost" figure: a tombstone from step 3 can offset a send that was lost, so a
difference of counts would say less than it seems to. Until lane g59 nothing wrote
`/tmp/at-failure.json` in the automated drill, and "no suppression lost" was measured
against the baseline alone, which never had the suppressions recorded after the target.
The runner hands the drill the at-failure counts as `--at-failure-json`, the drill writes
them to `step0-at-failure.json` and passes that file here, and the runner requires both
fields in the report and the after count at or above the at-failure one.

Attach `/tmp/restore-report.json` to the release record. Appendix G scenario 11 is exactly this table.

## Step 9. Advance the generation and release the restore holds

> *Appendix E.9: an authenticated admin advances `system_generation`; restore holds release only after every other applicable hold is reevaluated.*

This is a deliberate human act with a normal active, device-bound admin session. There is no automatic release.

```bash
# (FSS) refuses unless the step 8 report exists and has no unresolved exception.
fss admin system-generation advance --report /tmp/restore-report.json
```

The advance is attributed to an active admin: `--admin-user`, or `FSS_ADMIN_USER_ID`. The
automated drill hands it the workspace admin the evidence seed acted as, from the
`before` report's `adminUserId` (lane g59). The drill was launched without one until
then, so step 9 would have refused `admin_missing` on the first run to reach it.

Then prove the release was **selective**, which is the part that is easy to get wrong:

```bash
fss admin holds list
```

Assertions:

- every `restore_in_progress` hold is gone;
- every **other** hold that was in force before the restore is **still in force**: mailbox health, uncertain reply, ambiguity, administrative pause, reassignment, long-hold review. Clearing one hold never clears another (spec 4.3);
- automation resumes only for opportunities that are automated **and** have no applicable hold;
- unexecuted work has shifted by the **union** of blocking intervals, not their sum;
- any enrollment whose union exceeds seven calendar days is still held for salesperson review and explicit resume;
- every resume performed a fresh eligibility check.

"Before" means immediately before the advance. The drill counts the holds other than the
restore holds at that instant, and requires at least one, so selectivity is actually
tested: the `before` phase's administrative pause is that hold. Until lane g59 the count
was taken before step 1, so a hold steps 2 to 8 rightly released — step 3 ends the
in-doubt send's `send_unknown_reconciling` hold once the Sent folder proves delivery —
was read as one the advance had cleared.

```bash
aws cloudwatch describe-alarms --alarm-names "${PREFIX}-restore-generation-mismatch" \
  --query 'MetricAlarms[0].StateValue'
# expect: OK
```

**The pin after step 9** (lane g56). Step 9 inserts generation `max + 1`, which is R + 1: exactly the pin set at step 1. So the pin needs no change here, and must not get one. Confirm that `generation` in the advance's report equals `expected_system_generation`. Only if it does not, set the pin to the reported generation and apply before any worker restarts. A worker restarted on a pin that disagrees with the database reopens restore holds that step 9 released. Releasing those takes another advance, which moves the database past the pin again. The drill asserts this as `step9-generation-reconciled`: the database is on the pin, and the worker's startup check run with it opens nothing.

## 10. Tear the drill down

```bash
aws rds delete-db-instance --db-instance-identifier "${PREFIX}-pg-restored" --skip-final-snapshot
cd infra/roots/rehearsal
terraform destroy -var="name_prefix=${PREFIX}" ...same vars as the apply...
```

The rehearsal journal bucket uses GOVERNANCE object lock with a one-day retention, so objects written during the drill refuse deletion until that day passes. Either wait, or give the rehearsal deployment role `s3:BypassGovernanceRetention` scoped to `fss-rh-*` buckets only. That permission must never be on the production role.

## 11. Pass and fail

The drill **passes** when all of these hold:

1. sending and dialing were held from the moment of restore until step 9;
2. no send repeated;
3. no suppression was lost, and the journal replay is idempotent;
4. every reply, opt-out, direct send and bounce in the window reapplied its effect;
5. coverage is proven complete for every mailbox;
6. schema ranges agree;
7. the reconciliation report is complete and its only loss is the reported CRM RPO;
8. advancing the generation released **only** the restore holds.

Any single failure fails the release. In particular a repeated send or a lost suppression is not a bug to file and move past; it is invariants 1 and 4 of the specification.

A step the drill could not answer is a failure too. Its report lists it under `unanswered` with the prerequisite it lacked, and runs the steps after it so they are measured, but a report with anything in `unanswered` is not a pass (lane g59). Today that is `step1-dial-refused`, for the reason in 0.1.

## 12. Recurring drill

Outside a release, run this against a dedicated rehearsal environment on a schedule David sets. Record, each time: the observed lag between the requested restore point and the actual restorable point, the wall-clock duration of each of the nine steps, and the CRM RPO. Those three numbers are what let Callie state a real recovery objective instead of a hoped-for one.
