# g74: CI publishes the images, the weekly rehearsal pins them, and a manifest binds the release

Lane g74, 25 September 2026. Audit items O10, O09, O11 and O17 of
`GPT6-ASTRA-EXHAUSTIVE-20260925.md`. This records four choices the lane had to make.
None of them changes IAM, a trust relationship, an `infra/modules` file, the release
record's shape, or `release-deploy.sh`.

## 1. CI pushes to the two rehearsal repositories, with the role it already had

**The gap (O17).** `greenfield-images.yml` built and verified both images, and the
digest it printed was a local build's, never the registry's. The operator then rebuilt
the same commit on a Mac and pushed. Two builds of one commit are two sets of bytes, so
what CI verified was not what production ran.

**Decision.** A `publish` job in `greenfield-images.yml` runs on every push to main that
changes an image input. It runs in the `rehearsal` environment and assumes
`fss-rh-deploy`. It pushes each image once as `fss-rh-<image>:ci-<commit>`, reads the
digest back from ECR, pulls that digest and verifies it with the same checks the
pull-request job runs (`release-images.sh verify`). It then publishes both digests as
the artifact `fss-image-digests` and in the step summary. No file is committed.

- **Why this role and no new one.** `fss-rh-deploy` trusts the subject
  `repo:david-cui-bruno/founding-sales:environment:rehearsal`, which any job in that
  environment presents. Its policy template already grants `ecr:*` on
  `repository/fss-rh*`. So nothing in IAM changed, and the role still cannot write
  `fss-prod-*`.
- **Why `ci-<commit>`.** The repositories are IMMUTABLE and the operator's pushes used
  `<commit>`. A separate prefix means CI never collides with an operator tag. A re-run
  of the same commit finds its own tag and reuses the digest instead of pushing a
  second build under it.
- **What changes for the operator.** The production copy becomes
  `infra/scripts/release-promote.sh <release-manifest.json>`. The fast path uses
  `release-promote.sh <image-digests.json> --app-only` instead. Both copy by digest from
  `fss-rh-*` to `fss-prod-*` with `docker buildx imagetools create`, the convention of
  the old `fss-prod-images.sh`. Both refuse unless production reads back the same
  digest. The flag is required for CI's digests because no full rehearsal has passed
  with them, and the release cadence allows that for the app-only fast path only.
  Nothing is rebuilt.
- **Rejected: CI keeps no credential and the operator pushes CI's exact bytes.**
  Passing ~300 MB OCI archives through workflow artifacts would put the whole
  repository's artifact quota at risk. The weekly run would also still wait for a
  person.
- **Rejected: a conditional `environment:` on the single images job.** An expression
  that evaluates to no environment is behaviour this lane could not verify offline. If
  it were wrong, every pull request's image build would break.

`push.paths` now lists exactly `release-images.sh inputs`, and the release suite compares
the two. That added `certs/**`, which both Dockerfiles copy and which the list used to
miss.

## 2. The weekly run calls the release workflow, and wakes hourly on Sunday

**The gap (O10).** The weekly full rehearsal was accepted and never scheduled.

**Decision.** `greenfield-weekly-rehearsal.yml` runs three jobs, `slot`, `pin` and
`rehearsal`. `rehearsal` calls `greenfield-release.yml` through `workflow_call` with
`stage: full` and three pinned artifacts. The first two are the digests CI published for
this commit's image inputs. The third is the desktop stamp, which is this commit. The
caller also passes `pinned_commit`, and the called run refuses unless it checked out
that commit, its stamp is that commit, and its stage is `full`.

- **Why `workflow_call` and not `gh workflow run`.** A called workflow runs from its
  caller's commit, so the pin and the checkout cannot drift apart. A dispatch starts at
  whatever main is when it lands, and a merge in between would rehearse code the pin
  never looked at. The price is a two-word widening of the rehearsal job's condition,
  from `workflow_dispatch` to `workflow_dispatch || schedule`, and a `workflow_call`
  block that repeats the five dispatch inputs.
- **What "the images CI built for this commit" means.** The images workflow runs only
  when an input changes. So the pin takes the newest green publish run on main whose
  commit is an ancestor of this one and whose image inputs are byte-identical to this
  commit's (`git diff --quiet`). A documentation commit on top of an image change
  rehearses that change's images: same inputs, so same image. An image change whose
  publish failed is a refusal. The manifest repeats that comparison in the job that ran
  the suite.
- **Why hourly on Sunday.** GitHub's `schedule` cannot read a variable, and it drops
  events: the nightly's first 09:00 event, on 25 September, never fired. The workflow
  wakes at minute 23 of every Sunday hour and `ci-schedule.sh slot` decides. It runs on
  Sunday at `FSS_WEEKLY_REHEARSAL_HOUR_UTC` (default 9; `off` pauses). A later hour
  catches up only if no run since the slot got as far as pinning, so a slot that
  passed or failed runs once. Twenty-four one-minute jobs a week is the cost.
- **Rejected: 168 hourly runs so the day is a variable too.** The cost is seven times
  higher, and nobody asked to move the day.

A manual dispatch defaults to `dry_run`. It pins and prints, and runs no rehearsal.

## 3. The manifest is a sibling of the release record, not new fields in it

**The gap (O09).** The record names two digests and a stamp that the dispatch supplied.
Nothing tied it to the checkout, the run, where the images came from, the desktop
version, or what production later deployed.

**Decision.** `release-manifest.sh write` runs on a green `full` run, after the record.
It writes `release-manifest.json` (`fss.release-manifest.v1`), which carries:

- the record's reference and SHA-256;
- the checkout commit;
- the run id, attempt, URL, event and trigger;
- both digests and their provenance: `ci` with the images run and commit and
  `inputsMatchCheckout: true`, or `dispatch-input` with nulls;
- the desktop stamp, whether it is the checkout, and `vars.FSS_DESKTOP_APP_VERSION`;
- `deployed: null`.

`verify` runs at once. Refusing is the point of both commands. The manifest and record
are kept together as the artifact `fss-release-manifest`. After a production deploy,
`release-manifest.sh deployed` reads, and only reads, both services and their task
definitions. It writes the task definition ARNs and digests into `deployed`, or writes
nothing on a mismatch.

The record is untouched because production stores it through a strict contract
(`releaseRecordSchema`), and `release-deploy.sh --release-record` (lane g80) reads it. A
new field there is a record production refuses.

## 4. Freshness is an issue, from GitHub's own API

**The gap (O11).** A scheduled run that never starts sends no failure e-mail.

**Decision.** `greenfield-freshness.yml` runs at 13:41 and 21:41 UTC. Its token has
`actions: read` and `issues: write` and nothing else. It checks two things:

- the newest successful nightly on main must be under 30 hours old;
- the newest `fss-release-manifest` artifact from main must be under eight days old.
  That artifact exists only for a green full rehearsal, weekly or dispatched.

Either one stale fails the run and opens one issue, marked
`<!-- fss-schedule-freshness -->`, that mentions the repository owner so the notice
arrives by e-mail. If the issue is already open, the run updates it instead. It tries
to pin the issue, and a token that may not is only a warning. It comments only when
the set of stale checks changes, and it closes the issue when everything is fresh.
"Never ran" counts as stale once the workflow is older than its limit. A paused weekly
schedule is reported, not alarmed.

- **Rejected: a CloudWatch alarm on a heartbeat metric.** It needs IAM and a credential
  in CI. It would also measure the cloud rather than the scheduler that failed.
- **Residual risk.** This workflow is scheduled too. Two daily events at different
  hours make one dropped event harmless. Both being dropped for a day is not covered.

## What this lane could not verify

It made no cloud or GitHub call. These have not happened yet:

- a `publish` push to ECR;
- a `workflow_call` of the release workflow, including whether GitHub applies the
  callee's workflow-level `concurrency` group to a called run (documented behaviour,
  not observed here);
- a `pinIssue` mutation by `GITHUB_TOKEN`;
- `release-promote.sh` or `release-manifest.sh deployed` against real ECR or ECS.

If the `rehearsal` environment has a required reviewer, `publish` and the weekly run
both wait for an approval.
