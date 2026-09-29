# Operating FSS

The one page for running production. `docs/greenfield/release.md` holds the invariants underneath it, `docs/greenfield/infra-apply-runbook.md` how the infrastructure comes into existence, and `runbooks/restore.md` the restore.

## The shape

One workspace and one salesperson. Two processes run in AWS us-east-1, account `326255650484`, under the name prefix `fss-prod`: an API (`fss-prod-api`, two Fargate tasks) and a worker (`fss-prod-worker`, one), in the cluster `fss-prod-cluster`, behind a load balancer at `https://api.usecallie.com`. Their database is one Multi-AZ RDS PostgreSQL 16 instance, private — `publicly_accessible = false`, no NAT gateway, no bastion — so anything that must reach it runs as a one-off ECS task inside the VPC. The Mac app is an Electron build published to the CloudFront updates distribution, which every Mac reads at `releases/darwin-arm64/latest.json`. Sending is on.

- **Four task definitions**, all from `infra/modules/cluster`: `fss-prod-api` and `fss-prod-worker`, which the services run and which carry `track_latest = true`, so Terraform reads CI's newest ACTIVE revision as its own; and the one-off `fss-prod-migration` and `fss-prod-operations`, which carry the worker image of the last apply.
- **The applied schema is what the last migration recorded**, and every declared range is a strict `{N,N}` (`packages/domain/db/schemaRange.ts`), so no build straddles a schema change and a schema release is an outage on purpose. Read the number rather than trusting this page: `deploy.sh current fss-prod` prints the ranges each running service accepts, and `GET /diagnostics` prints `schema.appliedVersion`. Production recorded 0001 to 0019; 0020 (the postal address) and then 0021 (the compatibility cleanup) are the next two releases, each from the schema before it. Migrations are forward-only and immutable once applied: the runner checksums each file's bytes.
- **Four Terraform roots** under `infra/roots/`: `production`, `production-google` (the Gmail push objects and the CI identity; planned and applied only by `greenfield-google.yml`, below), `rehearsal`, `rehearsal-registry`. Production and rehearsal have distinct state keys, roles and namespaces, and `infra/scripts/lib.sh` refuses at the call any rehearsal command naming `fss-prod`.
- **Ten scripts and no others** in `infra/scripts/`: `deploy.sh`, `images.sh`, `lib.sh`, `offline-gate.sh`, `policy.sh`, `preflight.sh`, `record.sh`, `rehearsal.sh`, `rollback.sh`, `stop.sh`. Each one's header is its usage.
- Metrics go to `FSS/fss-prod`, never the bare `FSS`. Plan from main only, at the commit being released. `infra/scripts/deploy.sh current fss-prod` is the first command of any manual release: it prints `api_image=`, `worker_image=`, `api_schema_range=`, `worker_schema_range=` — the four a plan is made from — and then the two services' database hosts.

## An app change

Merge to main. *Greenfield images* publishes the two images and *Greenfield deploy* (`.github/workflows/greenfield-deploy.yml`) deploys them itself as `fss-prod-ci-deploy`: it reads the gate, promotes the digests, puts the release record **before** the rollout, rolls the worker and then the API, smokes, and reads the record back. Nothing to run.

Check that the run is green, that its summary names both new revisions, and that the read-back job says `existing`. A read-back that fails after a passing smoke does not hold sending: the record went in before the rollout.

**The `manual` answer.** The workflow reads every commit between production's own commit and the images commit, and answers `manual` — a green run, a notice, nothing touched — when one of them changed `infra/**` (`infra/scripts/` included), a migration, `packages/domain/db/schemaRange.ts`, `migrationRunner.ts`, `queryable.ts`, `scripts/productionSmoke.mjs`, `.github/**`, or a path its list does not know. It also answers `manual` when a running image carries no commit tag, and it keeps answering `manual` until production runs images built after the change.

The hand path is steps 1, 4, 5 and 6 of the next section without the rehearsal, the preflight, the stop or `--schema-change`: pin the digests, the record, the plan, `images.sh promote`, the apply, `deploy.sh release`, the smoke. Release the protected change that way, then the first app merge after it the same way; from the merge after that, CI takes over again.

## A schema or infrastructure release

Pin, rehearse, preflight, stop, apply, deploy, smoke — with the admin profile, from a checkout of main at the release commit. **Every variable below is bound before it is used**, which is what step 1 is for: `$worker_digest` does not exist until `images.sh pin` has written it, so nothing earlier than step 1 may name it.

**1. Pin the digests, and check the role read-only.** `images.sh pin` resolves the release commit's published images and writes the five names every later step uses; `policy.sh check` proves the deploy role can do what the release needs and writes nothing.

```bash
export GITHUB_REPOSITORY=david-cui-bruno/founding-sales
export RELEASE_COMMIT="$(git rev-parse HEAD)"
mkdir -p /tmp/fss-ci
infra/scripts/images.sh pin "$RELEASE_COMMIT" /tmp/fss-ci/image-pin.json > /tmp/fss-ci/pin.env
. /tmp/fss-ci/pin.env   # api_digest worker_digest images_run_id images_commit gate_run_id
infra/scripts/policy.sh check fss-prod-deploy fss-prod
```

**2. The rehearsal**, dispatch only, in its own `fss-rh-<suffix>` namespace:

```bash
gh workflow run greenfield-release.yml --ref main -f mode=schema -f stage=full \
  -f api_image_digest="$api_digest" -f worker_image_digest="$worker_digest" \
  -f desktop_commit_stamp="$RELEASE_COMMIT"
```

`stage` is `plan`, `create`, `deploy`, `full` or `teardown`; each of the first four runs everything before it, and one is worth running only once the one before it passed. About 45 minutes at `full`. An app-only or desktop-only release needs no rehearsal.

**3. The preflight, on production, while both services are still running.** A migration's own counts, inside a rolled-back READ ONLY transaction, on a one-off task of the operations definition with **this release's** worker image. It exits 3 when the migration would refuse, so the chain stops here rather than with both services at zero. It runs *after* the rehearsal and *before* the stop, and only a migration that **can refuse** has one: a migration with no condition under which it raises has no `fss admin schema-preflight` command and the release skips this step. **0022 is one of those** — it adds a table and nothing else, so there is nothing for a preflight to count or to stop on. The 0021 text below is kept as history: it is what this step looks like when a migration can refuse.

```bash
infra/scripts/preflight.sh infra/roots/production fss-prod 0021 --worker-digest "$worker_digest"
```

The report lands in the reports directory as `schema-preflight-0021.txt` and on stdout in full. For 0021 it must say `migration=21 schema=20 applicable=true refuses=false`: the preflight of 0021 counts a **schema-20** database — before it the release is not this one, after it 0021 has already run — and `refuses=true` means the migration would raise `FS021`. Do not release it then: take the blocking counts (`review_required_enrollments`, with the ids) to the owner and amend the migration before it is applied anywhere. The counts under `destroyed` are reported, not blocking.

**0021 has one check the database cannot make.** It is only safe because no desktop older than 1.0.14 is in use, and no row says which build is installed. The report says so (`installed_client_check=by_hand:…`, which lists what each registered Mac last told the server — evidence, not proof). **Confirm 1.0.14 on David's Mac by hand before the stop.**

**4. The record, before the plan.** The worker admits a send only while a stored record names its own digest, so a put after the rollout leaves every worker task that starts during it without one.

```bash
infra/scripts/record.sh from-ci "$gate_run_id" "$images_commit" "$api_digest" "$worker_digest" \
  --images-run "$images_run_id" --out /tmp/fss-ci/release-record.json
infra/scripts/record.sh put infra/roots/production fss-prod \
  --api-digest "$api_digest" --worker-digest "$worker_digest" \
  --release-record /tmp/fss-ci/release-record.json
```

**5. Plan, promote, stop, apply, deploy.** An infrastructure change that moves no image plans from what production runs, and nothing else:

```bash
(cd infra/roots/production && terraform plan -out=production.tfplan \
   $(../../scripts/deploy.sh current fss-prod --var-flags))
```

A schema release plans with its own four values instead — the release's two digests, against the `fss-prod-api` and `fss-prod-worker` references `terraform output repository_urls` prints, and the two ranges **read from the source rather than typed**, because a typed number is how a release ends up declaring the schema it is leaving:

```bash
read -r api_range worker_range <<<"$(node --experimental-transform-types --disable-warning=ExperimentalWarning --input-type=module -e '
  const m = await import("./packages/domain/db/schemaRange.ts");
  const r = n => `{min=${n.minimum},max=${n.maximum}}`;
  console.log(r(m.API_SCHEMA_RANGE), r(m.WORKER_SCHEMA_RANGE));
')"
echo "$api_range $worker_range"   # the 0021 release: {min=21,max=21} {min=21,max=21}
(cd infra/roots/production && terraform plan -out=production.tfplan \
   -var="api_image=<fss-prod-api repository>@$api_digest" \
   -var="worker_image=<fss-prod-worker repository>@$worker_digest" \
   -var="api_schema_range=$api_range" -var="worker_schema_range=$worker_range")
```

Both `-var=` values stay quoted, and `read` is what binds them: an unquoted `{min=21,max=21}` is brace-expanded by the shell into two words and the plan is given `min=21` as a range.

The two ranges must be the schema the release is **going to**, never the one it is leaving: for 0021 that is `{min=21,max=21}` over a database still at 20. The previous release's images declare `{20,20}` and refuse schema 21 at startup, which is why nothing of theirs may be running while the migration is applied.

Read the plan. It must show no change to an ECR repository, and for a schema release exactly the four task definitions replaced and the two services re-pointed. Then:

```bash
infra/scripts/images.sh promote /tmp/fss-ci/image-pin.json
infra/scripts/deploy.sh current fss-prod --compare "<api_image>" "<worker_image>" --allow-digest-change
infra/scripts/stop.sh infra/roots/production fss-prod --environment production
(cd infra/roots/production && terraform apply production.tfplan)
infra/scripts/deploy.sh release infra/roots/production fss-prod --schema-change \
  --api-digest "$api_digest" --worker-digest "$worker_digest" \
  --release-record /tmp/fss-ci/release-record.json
```

`--compare` is the last check that no CI deploy landed since the plan; a schema release passes `--allow-digest-change` because its images are new on purpose, and an infrastructure release does not. The stop takes the API to zero first, then the worker, each waited on and read back at zero; the apply cannot restart them (`ignore_changes = [desired_count]`); `--schema-change` refuses unless both are still at zero and unless each service is already on its family's newest ACTIVE revision (the apply's), then migrates — this is the moment 0021 is applied, with nothing of the old images running — ensures the database users in that same task, verifies, starts the worker and the API **together** under one wait, polls both until each has one PRIMARY deployment ECS calls `COMPLETED` on the applied revision at its declared count, and reads the record back, which must answer `existing`. An infrastructure change that moves no migration takes neither the stop nor the flag. Read both commands first with `FSS_REHEARSAL_DRY_RUN=1`, which prints every call and makes none.

**6. Smoke.**

```bash
AGE=$(aws cloudwatch get-metric-statistics --namespace FSS/fss-prod \
  --metric-name CanaryCompletionAgeSeconds --statistics Maximum \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --period 300 \
  --query 'reverse(sort_by(Datapoints,&Timestamp))[0].Maximum' --output text)
NODE_OPTIONS="--experimental-transform-types --disable-warning=ExperimentalWarning" \
  node scripts/productionSmoke.mjs --origin https://api.usecallie.com \
    --canary-age-seconds "$AGE" --expect-sending enabled
```

**A migration is immutable once applied**: a mistake is repaired by a later migration, never by editing the file, and the database never rolls back. **During a restore** (`runbooks/restore.md`, between its steps (f) and (g)) every production plan and apply must carry `-var=active_database_host=<the copy's address>`; `deploy.sh current fss-prod` prints the host each service runs on.

## A desktop release

The API goes first: publish a build only after the release it belongs to is deployed. Dispatch it, then publish it yourself — that workflow reaches no cloud and holds no AWS credential.

```bash
gh workflow run greenfield-desktop.yml --ref main -f release=true \
  -f desktop_commit_stamp="$RELEASE_COMMIT"
```

The run signs, notarizes and staples, and leaves the artifact `callie-macos-arm64-<version>` on itself, holding `Callie-<version>-arm64.zip` and `latest.json`. Publish with an operator session, **the zip first**: a manifest naming an object that is not there yet is refused by every Mac, which is safe but looks like an outage.

```bash
aws s3 cp "Callie-$VERSION-arm64.zip" \
  "s3://$BUCKET/releases/darwin-arm64/$VERSION/Callie-$VERSION-arm64.zip"
aws s3 cp latest.json "s3://$BUCKET/releases/darwin-arm64/latest.json" --cache-control 'max-age=300'
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths '/releases/darwin-arm64/latest.json'
```

`BUCKET` is `fss-prod-updates-326255650484`; the distribution is the one whose domain name `terraform output -raw updates_distribution_domain_name` prints.

## Sign-in and devices

**One credential.** A Mac opens a session with the long-lived device secret it has held in its Keychain since it was claimed (`POST /auth/session/open`, wave 3b). Opening does not rotate anything, so a session lost to a restore or an overwrite does not cost a full Google sign-in. The rotating refresh credential and `POST /auth/session/renew` went with migration 0021: that path is not served, `device_refresh_credentials` is dropped, and `credential_reuse` and `credential_expired` are no longer refusal codes a Mac can be told (`credential_unknown` covers an unknown device, a wrong secret and a device with no session — deliberately one answer). **The client minimum is 1.0.14** from that release: an older build reads routes and fields this server no longer has. It is refused every sign-in, every session it tries to open and every *receipted* command — the ones that carry a `clientVersion` in their body — and may read the upgrade instruction at `GET /auth/client-version`, which needs no session at all. Two mutations are not gated on the version, because neither carries one: while an old Mac still holds a live access token it can `POST /auth/sign-out` and `POST /devices/revoke`. That is deliberate — a Mac that cannot be used must still be able to give up its session and be taken away — and it is bounded by the access session's hour and the 30-day boundary, after which it cannot open another. **Sign-out revokes the device**: the `devices` row goes `revoked`, every active session it held ends `signed_out`, and the next sign-in registers a new device — a secret the Mac has forgotten must be dead at the server too, and a device carrying a `signed_out` session from before wave 3b is revoked the first time it tries to open. `GET /devices` lists this workspace's Macs and `POST /devices/revoke {"deviceId"}` takes one away, audited as `auth.device_revoked`; any active member may call both, and revoking one's own Mac is a sign-out.

## The Google root

`infra/roots/production-google` — the four Gmail push objects, the `github` workload identity pool and the `fss-prod-google-ci` service account — is planned and applied only by `.github/workflows/greenfield-google.yml`: `gh workflow run greenfield-google.yml --ref main -f stage=plan`, then read that run's `google-plan` artifact (`plan.txt` carries the plan's sha256 and the commit it was made at on its first two lines), then `gh workflow run greenfield-google.yml --ref main -f stage=apply -f plan_run_id=<that run id> -f plan_sha256=<that first-line digest>`. The apply refuses a plan run of another workflow, a plan from another commit, a run that is not its own first attempt (a re-run puts a second artifact under the same id), an artifact that no longer hashes to what was read or to the digest the dispatch names, and any destroy or replacement of a `module.pubsub` object. **No human Google credential is used again** (David, 27 September 2026): the workflow exchanges GitHub's OIDC token, for this repository's `production-deploy` subject alone, for a short-lived token of `fss-prod-google-ci@callie-fss.iam.gserviceaccount.com`, and there is no key file anywhere. What CI cannot change, and what therefore needs a person with application-default credentials (`docs/greenfield/infra-apply-runbook.md` 1.3a): the pool and its OIDC provider, the CI service account itself, that account's own grants, the push service account `fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com`, and any API enablement. CI holds `roles/pubsub.admin` plus four read roles and `roles/iam.serviceAccountUser` on the push account — enough to apply a Pub/Sub change, and nothing that can widen itself.

## Sending

Two halves, and both must hold. The deployment half is `FSS_SENDING_ENABLED=true`, from the committed `sending_enabled = true` in `infra/roots/production/main.tf`: changing it is a pull request, a read plan and an apply. The owner's half is an attestation written as an authenticated admin, naming a stored release record.

Production is attested under the **process form**, `ci-gate:main`, which admits any stored record with `source: "ci-gate"` that names the running digest. Only `record.sh from-ci` writes one, and only from a green *Greenfield gate* run of a push to main at the record's commit — so every CI deploy keeps sending on and nobody attests again. To go back to one release at a time, attest naming that record's `releaseGateReference`, which `record.sh put` prints back as `reference`.

**The send window** is 08:00 to 17:00, Monday to Friday, in the firm's own zone, minus the workspace holiday calendar, with 08:00 to 12:00 the preferred band. Outside it a send is refused `outside_email_window` and waits. The release half refuses with `release_record_unknown` (no `ci-gate` record names this worker: the hold after a deploy whose record was not put), `release_record_not_passing`, `release_record_digest_mismatch`, or `release_record_identity_unknown` (the process cannot read its own digest — fail-closed). Turning sending off is always accepted and takes effect at once; it does not cancel a fence already dispatching.

One e-mail a day says whether anything is wrong: the daily digest, below.

## Recovery

**Data wrong rather than code:** `runbooks/restore.md`, end to end. It is signed off and hand-run, and there is no faster version.

**Code wrong:** roll the images back, and **only the images**.

```bash
git -C ~/fss-prod checkout --detach <the previous release's commit>   # then terraform init there
infra/scripts/rollback.sh ~/fss-prod/infra/roots/production fss-prod \
  --api-digest "$PREVIOUS_API_DIGEST" --worker-digest "$PREVIOUS_WORKER_DIGEST"
# plans, prints the plan, stops. Add --apply to plan again, apply, deploy and smoke.
```

It refuses a checkout older than main `beed2d90`, and one that does not hold that commit: older Terraform declares the deleted restore drill, and a plan of it would create it again. **Never run Terraform across that boundary** — beyond it only the images move, by hand from main with `-var=api_image=…@<digest>` and `-var=worker_image=…@<digest>`, and the infrastructure is repaired forward. It refuses a rollback across a schema change too: after a migration the previous images refuse the schema at startup, so the paths are forward repair or a restore.

## Rehearsal clean-up

Every stage tears itself down and runs the guard on `always()`. When a run left something standing, dispatch the teardown stage — which needs the image inputs even though it reads none of them, because `workflow_dispatch` cannot require an input for one stage only:

```bash
gh workflow run greenfield-release.yml --ref main -f mode=schema \
  -f stage=teardown -f run_suffix=<the prefix to destroy> \
  -f api_image_digest="$api_digest" -f worker_image_digest="$worker_digest" \
  -f desktop_commit_stamp="$RELEASE_COMMIT"
```

`run_suffix` is required for it; every other stage falls back to a fresh timestamp, which would report `destroyed=nothing_created` and leave the orphan standing.

`infra/scripts/rehearsal.sh guard <prefix>` proves four facts: the run's Terraform state is empty, or the root was never initialised; the session is an assumed-role session of `fss-rh-deploy`, whose policy cannot address `fss-prod*`; nothing in the cloud still carries the run prefix; and neither lock record of the state key is left. The last two are `rehearsal.sh leftovers <prefix>`, which anyone can run by hand, from any directory: `rehearsal.sh` resolves the rehearsal root from its own location and names it to `terraform` with `-chdir`, so where you call it from changes nothing.

**A red guard means read by hand whatever it names, then dispatch `stage=teardown` again.** It fails closed on any answer it cannot read — a reading that cannot be made is not an absence. It reads the account, and not only the state, because the cancelled run of 26 September 2026 left an RDS instance, a load balancer and a CloudFront distribution that an empty state said nothing about. A cancelled `create` also leaves its state lock held and a teardown cannot take it: `terraform force-unlock <the lock id the error printed>` against that run's state key first, after reading the lock's `Who` and `Created` — a lock held by a running run is a run you must let finish.

## Secrets

Seven Secrets Manager entries, created empty by Terraform and listed in `infra/modules/secrets/main.tf`: `google-oidc-client`, `google-gmail-oauth-client`, `session-signing-key`, `device-credential-pepper`, `llm-classifier-api-key`, `migration-database` and `app-runtime-database`, each under `fss-prod/`. RDS manages an eighth, the master user secret, which nothing in the cluster may read.

Terraform never writes, reads or plans a value. A value goes in from stdin, so it reaches neither shell history nor the process table, and then the tasks are made to pick it up:

```bash
aws secretsmanager put-secret-value --secret-id fss-prod/<entry> --secret-string file:///dev/stdin
# paste, then Ctrl-D
aws ecs update-service --cluster fss-prod-cluster --service fss-prod-api --force-new-deployment
```

A task whose `secrets` block names an empty entry does not start at all, so entries are filled before a deploy, never after. **No secret value belongs in a file, a `tfvars`, a plan, a directive or a message** — only the entry's name does. The OAuth client secrets are pasted this way; `production-google` needs no pasted credential at all, and no browser login either (below).

## Alarms

Every threshold is one CloudWatch alarm over a metric the applications publish to `FSS/fss-prod`, and they roll up into exactly two composites: `fss-prod-critical` over every critical condition and `fss-prod-warning` over every warning. `ALARM` on a composite means at least one of its members is in `ALARM` now; `OK` means none is. Nothing e-mails on a transition.

The one e-mail is the **daily alarm digest** at **07:00 America/New_York** (evaluated in that zone, so it does not move at the daylight-saving changes), subject `Callie daily alarm digest — <date>`, to the addresses in `alert_emails`. It lists every `fss-prod-` alarm that is not `OK` now, `ALARM` first and then `INSUFFICIENT_DATA`, then every state change of the last 24 hours. A quiet day is one line: `All N alarms OK.` To have it now: `aws lambda invoke --function-name fss-prod-alarm-digest /dev/null`. To read the state without waiting:

```bash
aws cloudwatch describe-alarms --state-value ALARM --alarm-name-prefix fss-prod- \
  --alarm-types MetricAlarm CompositeAlarm --query '[MetricAlarms, CompositeAlarms][].AlarmName'
```

One page per alarm sits beside this one, named after the alarm key; `runbooks/README.md` says what they share. Read `## What must stay held` first: for most of these the blockage is the safety property, and clearing it is how a duplicate email or a prohibited call happens.
