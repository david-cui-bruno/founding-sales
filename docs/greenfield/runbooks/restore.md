# Restore production to a point in time

When production's data is wrong and a copy from before the damage is better; not for an
instance failure, which Multi-AZ fails over. Replaces the nine-step protocol and the restore
drill (lane W3-S8). About an hour of outage, nothing sends meanwhile. Merge nothing to main
until (f): an app-only merge deploys itself and starts the services. One `bash` (lib.sh is
bash), a production checkout at main with the production root initialised as for a
release, node 24, the admin profile. Nothing starts the API or the worker before (f).

**Only while the instance being replaced can be read.** (d) reads from it every mailbox it
has and every mailbox its audit trail says was ever connected, to know whose Sent folder to
read. It is identified by instance, not by name: (a) pins its `DbiResourceId` through the
RDS API and writes a fresh marker into it before anything stops, bound to `T` and that id,
and (d) requires the marker there, bound the same way and written after `T`, and its
absence from the copy. The marker is a state witness (anything holding the runtime
credential could write one); the RDS pins are the identity. If `fss-prod-pg` is gone or
cannot be read, (a) or (d) answers NO-GO: escalate. Nothing else can say which mailboxes
could have sent since `T`, and no list is typed.

**How it stops.** Each step is one `&&` chain that begins `begin <step> <earlier steps>` and
ends `pass <step>`. A pass is a line in the ledger `$W/go` naming this restore: a
fingerprint of `T`, `$NEW`, the old instance's id and address, the marker and the running
digests, all fixed in (a). `begin` needs the earlier steps' lines under the same
fingerprint, then deletes the step's own line and every later one: rerunning a step voids
everything after it, and a new `T` or copy voids everything. A command that fails ends its
chain, so `pass` is not written and every later step answers `NO-GO`. Never write the
ledger by hand. A new shell runs the setup again and continues. One restore at a time:
move `$W` aside when it is retired.

```bash
: "${AWS_PROFILE:?export AWS_PROFILE=<the admin profile> first}"; export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
PATH="$(brew --prefix node@24)/bin:$PATH"
source infra/scripts/lib.sh; set +e   # lib.sh sets -e, and so do its functions: each helper calling one is a subshell
R=infra/roots/production; W=$HOME/fss-restore; mkdir -p "$W" && chmod 700 "$W" && touch "$W/go"
[ -f "$W/restore.env" ] && source "$W/restore.env"
STEPS="stopped restored pointed reconciled recorded started retired"; TD=module.stack.module.cluster.aws_ecs_task_definition
REPLACE="-replace=$TD.api -replace=$TD.worker -replace=$TD.migration -replace=$TD.operations"   # split on purpose, as $(cat "$W/vars")
keep() { printf '%s=%q\n' "$1" "$2" >> "$W/restore.env" && eval "$1=\$2"; }
restore_id() { [ -n "${T:-}" ] && [ -n "${NEW:-}" ] && [ -n "${OLD_DBI:-}" ] && [ -n "${OLD_HOST:-}" ] && [ -n "${MARKER:-}" ] \
  && [ -s "$W/vars" ] && { printf '%s\n' "$T" "$NEW" "$OLD_DBI" "$OLD_HOST" "$MARKER"; cat "$W/vars"; } | shasum -a 256 | cut -c1-16; }
need() { local id s; id=$(restore_id) || { echo "NO-GO: (a) has not fixed this restore" >&2; return 1; }
  for s in "$@"; do grep -q "^$s $id " "$W/go" || { echo "NO-GO: $s has not passed for restore $id" >&2; return 1; }; done; }
begin() { set +e; local step=$1 s later='' on=''; shift; [ "$#" -eq 0 ] || need "$@" || return 1
  for s in $STEPS; do [ "$s" = "$step" ] && on=1; [ -n "$on" ] && later="$later $s"; done
  awk -v drop="$later" 'BEGIN { n = split(drop, d, " "); for (i = 1; i <= n; i++) x[d[i]] = 1 } !($1 in x)' "$W/go" > "$W/go.new" \
    && mv "$W/go.new" "$W/go"; }
pass() { local id; id=$(restore_id) && echo "$1 $id $(date -u +%FT%TZ)" >> "$W/go" && echo "GO: $1 ($id)"; }
digests() { API=$(sed -n 's/^-var=api_image=.*@//p' "${1:-$W/vars}") && WORKER=$(sed -n 's/^-var=worker_image=.*@//p' "${1:-$W/vars}") \
  && [ -n "$API" ] && [ -n "$WORKER" ]; }
at_dbi() { aws rds describe-db-instances --filters "Name=dbi-resource-id,Values=$1" --query 'DBInstances[0].Endpoint.Address' --output text; }
rds_state() { aws rds describe-db-instances --db-instance-identifier "$1" --query 'DBInstances[0].[DbiResourceId,Endpoint.Address,DBInstanceStatus]' --output text; }
task_host() { release_json_path "$(release_output $R task_network_configuration json)" database_host; }   # what the task definitions reach
live_hosts() ( # FSS_DATABASE_HOST in the task definitions the running api and worker services use, one line each
  cluster=$(release_output $R cluster_arn) || exit 1
  for s in api worker; do
    td=$(aws ecs describe-services --cluster "$cluster" --services "fss-prod-$s" --query 'services[0].taskDefinition' --output text) \
      && aws ecs describe-task-definition --task-definition "$td" --output text \
        --query "taskDefinition.containerDefinitions[?name=='$s'] | [0].environment[?name=='FSS_DATABASE_HOST'] | [0].value" || exit 1
  done
)
report() ( rm -f "$W/$1.json"; release_captured_report "$W/$1.log" "$W/$1.json" )
fss_task() ( # fss_task <step> <migration|operations> [--capture F] [--env NAME=VALUE]... -- <fss words>...
  step=$1 kind=$2; shift 2; [ "${1:-}" != --capture ] || rm -f "$2"
  who=$(aws sts get-caller-identity --query Arn --output text) && [[ $who == arn:aws:* ]] \
    && td=$(release_output $R "${kind}_task_definition_arn") && net=$(release_output $R task_network_configuration json) \
    && img=$(aws ecs describe-task-definition --task-definition "$td" --output text \
      --query "taskDefinition.containerDefinitions[?name=='$kind'].image | [0]") || exit 1
  secret=''; [ "$kind" != operations ] || secret=$(release_output $R app_runtime_database_secret_arn) || exit 1
  release_run_task --step "restore-$step" --environment production --prefix fss-prod \
    --account "$(release_caller_account)" --region us-east-1 --cluster "$(release_output $R cluster_arn)" \
    --task-definition "$td" --container "$kind" --network-plan "$net" --image-digest "${img#*@}" \
    --database-host "$(release_json_path "$net" database_host)" --secret-arn "$secret" \
    --log-group "$(release_output $R worker_log_group_name)" --log-stream-prefix "$kind" --env "FSS_LAUNCHED_BY=$who" "$@"
)
fill_migration() ( # fill_migration <instance> <host>: the migration entry gets its master credential; nothing echoed
  arn=$(aws rds describe-db-instances --db-instance-identifier "$1" --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text) \
    && [[ $arn == arn:aws:secretsmanager:* ]] && db=$(release_output $R database_name) \
    && target=$(release_output $R migration_database_secret_arn) \
    && aws secretsmanager get-secret-value --secret-id "$arn" --query SecretString --output text \
    | python3 -c 'import json, sys; m = json.load(sys.stdin)
print(json.dumps({"username": m["username"], "password": m["password"], "host": sys.argv[1], "port": 5432, "dbname": sys.argv[2]}))' "$2" "$db" \
    | aws secretsmanager put-secret-value --secret-id "$target" --secret-string file:///dev/stdin >/dev/null
)
check_plans() ( # check_plans <repoint|retire> <plan> <reference plan> <plan's host> <reference's host>
  node --experimental-strip-types --disable-warning=ExperimentalWarning apps/worker/src/tools/restorePlan.ts "$1" \
    --plan <(terraform -chdir=$R show -json "$2") --reference <(terraform -chdir=$R show -json "$3") --plan-host "$4" --reference-host "$5"
)
audit_launch() ( # audit_launch <release report>: waits up to 21 minutes for CloudTrail's RunTask for the report's task, which must name the launcher it claims
  task=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["taskArn"])' "$1") \
    && who=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["launchedBy"])' "$1") || exit 1
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do
    verdict=$(aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RunTask \
      --start-time "$(date -u -v-1d +%FT%TZ)" --output json | python3 -c 'import json, sys
task, who = sys.argv[1:3]; events = [json.loads(e["CloudTrailEvent"]) for e in json.load(sys.stdin)["Events"]]
hit = [e for e in events if any(t.get("taskArn") == task for t in (e.get("responseElements") or {}).get("tasks") or [])]
print("match" if len(hit) == 1 and hit[0]["userIdentity"]["arn"] == who else "mismatch" if hit else "absent")' "$task" "$who") || verdict=unreadable
    case $verdict in
      match) echo "GO: CloudTrail shows $who launching $task"; exit 0 ;;
      mismatch) echo "NO-GO: CloudTrail shows another caller launching $task, not $who" >&2; exit 1 ;;
    esac
    echo "waiting for CloudTrail's RunTask ($attempt of 14: $verdict)" >&2; sleep 90
  done
  echo "NO-GO: CloudTrail has no RunTask for $task after 21 minutes" >&2; exit 1
)
```

**(a) Fix the restore, mark the old instance, and stop.** Set `T` first
(`T=2026-09-26T11:50:00Z`: UTC, just before the damage). This fixes `T`, the copy's name
`$NEW`, a fresh marker (every run of (a) makes a new one; a marker already bound to another
restore is refused), and the old instance by `DbiResourceId` and address (which must be the
host the task definitions reach), refusing unless `fss-prod-pg` is available. Then, before
anything stops, it writes the marker into the old instance through the operations task,
bound to `T` and that id, which is also the proof by SQL that the runtime login works
there. To change `T` or the copy later, `unset NEW`, set `T`, and run (a) again: nothing
passed before counts.

```bash
begin stopped && { [ -n "${T:-}" ] || { echo "NO-GO: set T first" >&2; false; }; } && keep T "$T" \
  && keep NEW "${NEW:-fss-prod-pg-r$(date -u +%m%d%H%M)}" && MARKER=$(uuidgen | tr '[:upper:]' '[:lower:]') && keep MARKER "$MARKER" \
  && SINCE=$(date -u -j -v-10M -f %Y-%m-%dT%H:%M:%SZ "$T" +%Y-%m-%dT%H:%M:%SZ) && keep SINCE "$SINCE" \
  && read -r OLD_DBI OLD_HOST OLD_STATUS <<<"$(rds_state fss-prod-pg)" \
  && [[ $OLD_DBI == db-* ]] && [ "$OLD_STATUS" = available ] \
  && [ "$OLD_HOST" = "$(release_output $R database_endpoint | cut -d: -f1)" ] && [ "$OLD_HOST" = "$(task_host)" ] \
  && keep OLD_DBI "$OLD_DBI" && keep OLD_HOST "$OLD_HOST" \
  && infra/scripts/deploy.sh current fss-prod --var-flags > "$W/vars" && digests \
  && fss_task marker operations --capture "$W/marker.log" -- admin restore-marker put --marker "$MARKER" --restore-point "$T" \
    --instance "$OLD_DBI" && report marker \
  && infra/scripts/stop.sh $R fss-prod --environment production && pass stopped
```

**(b) Restore to a new instance.** `T` must lie in exactly one restorable window of
`fss-prod-pg`'s automated backups, and that backup must be the pinned old instance's own
(its `DbiResourceId` is `$OLD_DBI`), not a retained one of an instance since replaced. The copy is told everything the module sets that a
restore does not carry over, so (g) finds only tags and Terraform's own settings to change,
and is then read back: its own `DbiResourceId` (pinned, and not the old one), its address,
and both KMS keys (storage and the managed master secret) as the module's key.
A rerun refuses while `$NEW` exists: delete it, or `unset NEW` and start again from (a).

```bash
begin restored stopped \
  && aws rds describe-db-instance-automated-backups --db-instance-identifier fss-prod-pg --output json > "$W/backups.json" \
  && DBI=$(python3 -c 'import datetime as d, json, sys
p = lambda v: d.datetime.fromisoformat(v.replace("Z", "+00:00")); t = p(sys.argv[2]); now = d.datetime.now(d.timezone.utc)
w = [b for b in json.load(open(sys.argv[1]))["DBInstanceAutomatedBackups"] if "EarliestTime" in b.get("RestoreWindow", {})
     and p(b["RestoreWindow"]["EarliestTime"]) <= t <= min(now, p(b["RestoreWindow"].get("LatestTime", now.isoformat())))]
print(w[0]["DbiResourceId"]) if len(w) == 1 else sys.exit("NO-GO: T is in %d restorable windows, not one" % len(w))' "$W/backups.json" "$T") \
  && { [ "$DBI" = "$OLD_DBI" ] || { echo "NO-GO: T is in the backups of $DBI, not of the pinned $OLD_DBI" >&2; false; }; } \
  && SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=fss-prod-database \
    --query 'SecurityGroups[0].GroupId' --output text) && [[ $SG == sg-* ]] \
  && KEY=$(aws kms describe-key --key-id alias/fss-prod-database --query KeyMetadata.Arn --output text) && [[ $KEY == arn:aws:kms:* ]] \
  && aws rds restore-db-instance-to-point-in-time --source-dbi-resource-id "$DBI" --target-db-instance-identifier "$NEW" \
    --restore-time "$T" --db-subnet-group-name fss-prod-db --db-parameter-group-name fss-prod-pg16 --vpc-security-group-ids "$SG" \
    --storage-type gp3 --max-allocated-storage 200 --ca-certificate-identifier rds-ca-rsa2048-g1 --auto-minor-version-upgrade \
    --multi-az --no-publicly-accessible --deletion-protection --copy-tags-to-snapshot \
    --enable-cloudwatch-logs-exports postgresql upgrade >/dev/null \
  && aws rds wait db-instance-available --db-instance-identifier "$NEW" \
  && aws rds modify-db-instance --db-instance-identifier "$NEW" --backup-retention-period 35 \
    --preferred-backup-window 07:30-08:00 --preferred-maintenance-window sun:08:30-sun:09:30 \
    --manage-master-user-password --master-user-secret-kms-key-id "$KEY" --apply-immediately >/dev/null \
  && sleep 60 && aws rds wait db-instance-available --db-instance-identifier "$NEW" \
  && read -r NEW_DBI NEW_HOST STORAGE_KEY SECRET_KEY ENCRYPTED <<<"$(aws rds describe-db-instances --db-instance-identifier "$NEW" \
    --query 'DBInstances[0].[DbiResourceId,Endpoint.Address,KmsKeyId,MasterUserSecret.KmsKeyId,StorageEncrypted]' --output text)" \
  && [[ $NEW_DBI == db-* ]] && [ "$NEW_DBI" != "$OLD_DBI" ] && [[ $NEW_HOST == *.* ]] && [ "$NEW_HOST" != "$OLD_HOST" ] \
  && [ "$STORAGE_KEY" = "$KEY" ] && [ "$SECRET_KEY" = "$KEY" ] && [ "$ENCRYPTED" = True ] \
  && keep NEW_DBI "$NEW_DBI" && keep NEW_HOST "$NEW_HOST" && pass restored
```

**(c) Point production at it**, then bring the copy forward. Two plans that differ only in
`active_database_host`, both replacing the four task definitions by request, so both carry
them as the configuration computes them. `check_plans` (`apps/worker/src/tools/restorePlan.ts`)
requires each to replace exactly `api`, `worker`, `migration` and `operations`, identical
between the two but for `FSS_DATABASE_HOST` (the copy's in one, the managed address in the
other), and to change only `task_definition` on the services `api` and `worker`, planned
identically in both; anything else is NO-GO. The services stay at zero
(`ignore_changes = [desired_count]`). `--rotate-password` sets the copy's runtime login to
the current secret, in case its password changed after `T`.

```bash
begin pointed restored \
  && terraform -chdir=$R plan -input=false -out="$W/point.tfplan" $(cat "$W/vars") $REPLACE -var="active_database_host=$NEW_HOST" \
  && terraform -chdir=$R plan -input=false -out="$W/point-reference.tfplan" $(cat "$W/vars") $REPLACE \
  && check_plans repoint "$W/point.tfplan" "$W/point-reference.tfplan" "$NEW_HOST" "$OLD_HOST" \
  && terraform -chdir=$R apply -input=false "$W/point.tfplan" && fill_migration "$NEW" "$NEW_HOST" \
  && fss_task migrate migration -- migrate && fss_task users migration -- admin database-users ensure --rotate-password \
  && fss_task schema operations --capture "$W/schema.log" -- schema-version && report schema \
  && python3 -c 'import json, sys; r = json.load(open(sys.argv[1])); sys.exit(0 if r["apiAccepts"] and r["workerAccepts"] else "NO-GO: %s" % r)' "$W/schema.json" \
  && pass pointed
```

**(d) Put back what the copy lost,** still stopped (the task definitions now reach the copy).
Both pinned instances still answer at their addresses, and the tasks reach the copy; the
report is read whatever the reconciliation answered, and `reconciled` is written only when
both succeeded.

```bash
begin reconciled pointed && [ "$(at_dbi "$OLD_DBI")" = "$OLD_HOST" ] && [ "$(at_dbi "$NEW_DBI")" = "$NEW_HOST" ] \
  && [ "$(task_host)" = "$NEW_HOST" ] && fss_task journal operations -- admin suppression-journal replay --from "$SINCE" \
  && { fss_task sent operations --capture "$W/sent.log" -- admin mailbox reconcile-sent --since "$SINCE" --restore-point "$T" --inventory-host "$OLD_HOST" --inventory-marker "$MARKER" --inventory-instance "$OLD_DBI"
       ran=$?; report sent && [ "$ran" -eq 0 ]; } && pass reconciled
```

The reconcile requires the marker on `$OLD_HOST`, bound to `T` and `$OLD_DBI` and written after
`T`, and its absence from the copy, then reads
from the old instance every mailbox address it has and every one its audit trail (which no
application role can delete from) says was connected, then each of those mailboxes' Sent
folders through a Gmail client that cannot send, watch or read a body, refusing any listing
page or message metadata that is not exactly one, and tombstones each FSS send the copy
lost. A refusal is a no-go until a rerun passes:

- `inventory_unreadable`, `inventory_marker_missing`, `inventory_marker_mismatch`,
  `inventory_marker_in_copy`, `inventory_empty`, `inventory_source_incomplete`, or `mailbox_not_in_inventory` in
  `unresolved`: the old instance cannot give the whole list, or is not the one (a) marked.
  Stop and escalate; abandoning (below) keeps production on the old instance.
- `sent_folder_unscanned` `rate_limited` or `message_vanished`: rerun. `malformed_response`:
  rerun once, then escalate. `truncated`: stop and escalate.
- `sent_folder_unscanned` `grant_revoked`, or `mailbox_not_in_copy`: this copy cannot prove what
  that mailbox sent. Restore again to a later `T` at which the mailbox had the grant it has now
  (`unset NEW`, set `T`, from (a)), or abandon.
- `unattached_sent_message`: a send no single step can be named for. Rerun (d) with
  `--hold-unattached` after `"$OLD_DBI"`: each firm it names (or the workspace, when none)
  gets a `restore_in_progress` hold, audited with the enrollments it could belong to, and
  after (f) an admin settles it and releases the hold as below.

**(e) The release record, and the holds.** The worker sends only while a stored record names
its digest, and the copy may predate the running release's: set `COMMIT` to the running
commit and `GATE_RUN` to the gate run `images.sh pin "$COMMIT" pin.json` names; `created` or
`existing` are both a pass. The open restore holds must be exactly those the passing (d)
opened: none released early, none left from before the restore.

```bash
begin recorded reconciled && digests && { [ -n "${GATE_RUN:-}" ] && [ -n "${COMMIT:-}" ] || { echo "NO-GO: set GATE_RUN and COMMIT" >&2; false; }; } \
  && infra/scripts/record.sh from-ci "$GATE_RUN" "$COMMIT" "$API" "$WORKER" --out "$W/record.json" \
  && infra/scripts/record.sh put $R fss-prod --api-digest "$API" --worker-digest "$WORKER" --release-record "$W/record.json" \
  && fss_task holds operations --capture "$W/holds.log" -- admin holds list --reason restore_in_progress && report holds \
  && python3 -c 'import json, sys
sent, holds = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
if (sent.get("since"), sent.get("inventory_host"), sent.get("inventory_marker"), sent.get("inventory_instance"), sent.get("restore_point"), sent.get("unresolved")) != (*sys.argv[3:8], []):
    sys.exit("NO-GO: sent.json is not the passing reconciliation of this restore")
held = {i for line in sent["unattached_held"] for i in line["holdIds"]}; now = {h["id"] for h in holds["holds"]}
sys.exit(0 if held == now else "NO-GO: released early %s; from before the restore %s" % (sorted(held - now), sorted(now - held)))' \
    "$W/sent.json" "$W/holds.json" "$SINCE" "$OLD_HOST" "$MARKER" "$OLD_DBI" "$T" && pass recorded
```

**(f) Start**, then release.md 6's smoke. Log `T`, `$NEW`, the ledger and `$W/sent.json` in
the running log. Until (g), every production plan carries `-var=active_database_host=$NEW_HOST`
(release.md): a plan without it points production back at the old instance.

```bash
begin started reconciled recorded && digests \
  && infra/scripts/deploy.sh release $R fss-prod --api-digest "$API" --worker-digest "$WORKER" && pass started
```

**Clearing a restore hold** (audited; nothing else releases one since the generation check
went). Set `WHY` to what was verified. The first line lists the holds; the second releases
every restore hold from before the restore, for (e) to pass on a rerun; the third releases
one hold (d) opened for an unattached send, after (f), with `HOLD` its id from
`$W/holds.json`. That release is a human decision, and the only one: `checked-no-duplicate`
is an attestation the command cannot check, recorded as `basis: human_attestation` with the
enrollments recorded when the hold opened and whether each had ended. Ending those
enrollments is no lasting fence, because a new enrollment of the same contact starts the
sequence again, so before releasing, verify and write into `WHY`:

1. The Sent message at the hold's `sentAt` in that mailbox: whom it went to and which step
   it was (for a workspace hold, whose recipient was unreadable, this is the only way to know).
2. That every enrollment of that contact that could send the same step again is ended in
   the app: the recorded ones (`hold.restore_opened` lists them) and any other.
3. What re-enrollment of that contact is allowed: a new enrollment starts at the first step,
   so if the send was a step of that sequence, the contact is not re-enrolled in it.

A firm hold shows on that firm's page in the Mac app. A workspace hold shows on no Firm page:
it is counted under `restore_in_progress` in the dashboard's holds and listed below.
Each release writes a `hold.restore_released` row with the note, the launcher's ARN and the
task's ARN, and a rerun answers `already_released`; it refuses outside an ECS task, since
without the task ARN nothing can check the launcher. The launcher's ARN is a claim:
`fss_task` takes it from `aws sts get-caller-identity`, but the task only checks its shape.
So a release is complete only when `audit_launch` has found CloudTrail's RunTask for that
task naming the same caller: it waits up to 21 minutes for the event, and its NO-GO (another
caller, or no event) goes in the running log and to David.

```bash
fss_task holds operations --capture "$W/holds.log" -- admin holds list --reason restore_in_progress && report holds
fss_task clear operations --capture "$W/clear.log" -- admin holds release-restore --note "$WHY" && report clear && audit_launch "$W/clear.json"
fss_task clear operations --capture "$W/clear.log" -- admin holds release-restore --hold "$HOLD" --resolution checked-no-duplicate \
  --note "$WHY" && report clear && audit_launch "$W/clear.json"
```

**(g) Later, on a quiet day, retire the old instance** (a short second outage). Before the
delete it checks that `fss-prod-pg` is still the old instance and the copy still the copy,
each `available` at its pinned address, that each answers SQL (a `schema-version` task
against each), that the task definitions the running `api` and `worker` services use carry
the copy's address, and that the final snapshot's name is free (only RDS's
`DBSnapshotNotFound` counts as free). After the rename it reads the renamed copy's own address rather than assuming the old
one, and uses it for the check and the migration entry. The check is (c)'s, the other way:
the task definitions return to the managed address, and the imported instance may change
only Terraform's own settings (`apply_immediately`, `delete_automated_backups`,
`final_snapshot_identifier`, `skip_final_snapshot`) and its tags; anything else, a
replacement above all, is NO-GO. Past the delete it cannot be rerun: continue by hand from
the link that failed. A failed import is undone with
`terraform -chdir=$R state push "$W/state-before-import.json"`.

```bash
begin retired started && FINAL="fss-prod-pg-pre-restore-$(date -u +%Y%m%d%H%M)" \
  && [ "$(rds_state fss-prod-pg)" = "$(printf '%s\t%s\tavailable' "$OLD_DBI" "$OLD_HOST")" ] \
  && [ "$(rds_state "$NEW")" = "$(printf '%s\t%s\tavailable' "$NEW_DBI" "$NEW_HOST")" ] \
  && [ "$(live_hosts | sort -u)" = "$NEW_HOST" ] && [ "$(task_host)" = "$NEW_HOST" ] \
  && fss_task retire-copy operations -- schema-version \
  && fss_task retire-old operations --env "FSS_DATABASE_HOST=$OLD_HOST" -- schema-version \
  && ! snapshot=$(aws rds describe-db-snapshots --db-snapshot-identifier "$FINAL" 2>&1) && [[ $snapshot == *DBSnapshotNotFound* ]] \
  && infra/scripts/deploy.sh current fss-prod --var-flags > "$W/vars.retire" && digests "$W/vars.retire" \
  && infra/scripts/stop.sh $R fss-prod --environment production \
  && terraform -chdir=$R state pull > "$W/state-before-import.json" \
  && aws rds modify-db-instance --db-instance-identifier fss-prod-pg --no-deletion-protection --apply-immediately >/dev/null \
  && aws rds delete-db-instance --db-instance-identifier fss-prod-pg --final-db-snapshot-identifier "$FINAL" \
    --no-delete-automated-backups >/dev/null \
  && aws rds wait db-instance-deleted --db-instance-identifier fss-prod-pg \
  && aws rds modify-db-instance --db-instance-identifier "$NEW" --new-db-instance-identifier fss-prod-pg --apply-immediately >/dev/null \
  && until aws rds describe-db-instances --db-instance-identifier fss-prod-pg >/dev/null 2>&1; do sleep 30; done \
  && aws rds wait db-instance-available --db-instance-identifier fss-prod-pg \
  && read -r RETIRED_DBI RETIRED_HOST <<<"$(aws rds describe-db-instances --db-instance-identifier fss-prod-pg \
    --query 'DBInstances[0].[DbiResourceId,Endpoint.Address]' --output text)" \
  && [ "$RETIRED_DBI" = "$NEW_DBI" ] && [[ $RETIRED_HOST == *.* ]] && keep RETIRED_HOST "$RETIRED_HOST" \
  && terraform -chdir=$R state rm module.stack.module.database.aws_db_instance.main \
  && terraform -chdir=$R import -input=false $(cat "$W/vars.retire") module.stack.module.database.aws_db_instance.main fss-prod-pg \
  && terraform -chdir=$R plan -input=false -out="$W/retire.tfplan" $(cat "$W/vars.retire") $REPLACE \
  && terraform -chdir=$R plan -input=false -out="$W/retire-reference.tfplan" $(cat "$W/vars.retire") $REPLACE \
    -var="active_database_host=$NEW_HOST" \
  && check_plans retire "$W/retire.tfplan" "$W/retire-reference.tfplan" "$RETIRED_HOST" "$NEW_HOST" \
  && terraform -chdir=$R apply -input=false "$W/retire.tfplan" && fill_migration fss-prod-pg "$RETIRED_HOST" \
  && infra/scripts/deploy.sh release $R fss-prod --api-digest "$API" --worker-digest "$WORKER" && pass retired
```

**To abandon before (f)**, after (b): point back at the old instance with (c)'s check the other
way, give the migration entry its credential again, start, then delete `$NEW` by hand. Before
(b) finished, starting is `digests && infra/scripts/deploy.sh release ...` alone. After (f) the
copy has served production, and abandoning it would lose what it recorded: restore again.

```bash
! need started 2>/dev/null && need restored \
  && terraform -chdir=$R plan -input=false -out="$W/abandon.tfplan" $(cat "$W/vars") $REPLACE \
  && terraform -chdir=$R plan -input=false -out="$W/abandon-reference.tfplan" $(cat "$W/vars") $REPLACE -var="active_database_host=$NEW_HOST" \
  && check_plans repoint "$W/abandon.tfplan" "$W/abandon-reference.tfplan" "$OLD_HOST" "$NEW_HOST" \
  && terraform -chdir=$R apply -input=false "$W/abandon.tfplan" && fill_migration fss-prod-pg "$OLD_HOST" && digests \
  && infra/scripts/deploy.sh release $R fss-prod --api-digest "$API" --worker-digest "$WORKER"
```

## Quarterly hand smoke (after the setup, with no restore in progress; writes only to a scratch copy)

The marker is written to production after the scratch copy exists, bound to a point taken
before the restore began, so the copy cannot have it and production's is written after it.

```bash
S=fss-prod-pg-smoke; SMOKE_SINCE=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ); SMOKE_POINT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SMOKE_MARKER=$(uuidgen | tr '[:upper:]' '[:lower:]'); read -r LIVE_DBI LIVE _ <<<"$(rds_state fss-prod-pg)"
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=fss-prod-database --query 'SecurityGroups[0].GroupId' --output text)
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier fss-prod-pg --target-db-instance-identifier $S \
  --use-latest-restorable-time --db-subnet-group-name fss-prod-db --db-parameter-group-name fss-prod-pg16 \
  --vpc-security-group-ids "$SG" --no-multi-az --no-publicly-accessible >/dev/null && aws rds wait db-instance-available --db-instance-identifier $S
H=$(aws rds describe-db-instances --db-instance-identifier $S --query 'DBInstances[0].Endpoint.Address' --output text)
fss_task smoke-marker operations -- admin restore-marker put --marker "$SMOKE_MARKER" --restore-point "$SMOKE_POINT" --instance "$LIVE_DBI"
fss_task smoke-schema operations --env "FSS_DATABASE_HOST=$H" -- schema-version
fss_task smoke-sent operations --env "FSS_DATABASE_HOST=$H" -- admin mailbox reconcile-sent --since "$SMOKE_SINCE" --restore-point "$SMOKE_POINT" \
  --inventory-host "$LIVE" --inventory-marker "$SMOKE_MARKER" --inventory-instance "$LIVE_DBI"
aws rds delete-db-instance --db-instance-identifier $S --skip-final-snapshot --delete-automated-backups >/dev/null
```
