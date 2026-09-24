# The drill has evidence to reconstruct, the rehearsal seeds it, and production never is

**Lane:** g40 · **Date:** 23 September 2026 · **Spec:** Appendix E steps 1 to 9, Appendix G 11; 4.1, 10.2, 11.2, 12.3, 12.4, 12.6, 12.7, 16.2 · **Evidence:** rehearsal full run 35930664547 at f44eb6bf, step 22

## What happened

The ninth full rehearsal reached the restore drill for the first time. Create, the
secret fill, step 17, g39's workspace bootstrap, g38's schema-range refusals, the
production smoke and the whole release suite in recorded mode all passed.

Step 22 then failed after 67 seconds. One in-VPC `fss admin counts --as-of <restore
target>` task ran against the source instance, and
`infra/scripts/rehearsal-restore-drill.sh` refused:

```
FAIL: the drill baseline has no sends, so reconstructing them would prove nothing
```

The refusal is correct, it is pinned by `test/release/scenario11.check.ts` and by a
mutation entry, and it could never have been anything else.
`docs/greenfield/restore-drill.md` section 0.1 requires six things to exist before the
restore target is read — an accepted send, a prospect reply that set an opportunity
manual, a prospect-originated opt-out, a salesperson's own manual suppression inside its
ten-minute window, an ordinary CRM edit, and an applied migration — and nothing in this
repository produced five of them in a deployed environment. There was no `fss` command
for it and no workflow step. The release suite (step 21) runs on the GitHub runner
against its own `postgres:16` service container; the rehearsal's database is private,
with no NAT gateway and no bastion, so the suite has never touched it and could not. A
fresh environment could therefore never pass step 22.

## The decisions

### 1. The seeding is a command, not a fixture, and it goes through the real paths

`fss admin drill seed-evidence` produces every row through the function that owns its
invariant: `createFirm`, `resolveZoneForFirm`, `createContact`, `addEmailRoute`,
`openOpportunity`, `createTemplateVersion` and `approveTemplateVersion`,
`createSequence`/`createDraftVersion`/`publishVersion`, `enrollContact`,
`prepareOutboundMessage`, `dispatchOutboundMessage`, `processMessageIds`,
`confirmReplyDisposition`, `recordSuppression`, `updateSetting`, `updateFirm`.

This is the whole point rather than a style preference. The drill's claim is that *after
a restore, FSS refuses to send or dial until every protected effect has been
reconstructed*. A fence seeded with an `INSERT` would let the drill prove that a restore
copies a row; a fence that reached `sent` through `decideSend` — the suppression check,
the frozen route, the applicable holds, the coverage watermark, 16.2's two switches,
12.7's authenticated sending domain, 11.2's window, the ramp's daily cap and the
personal-Gmail guard — is a fence whose reconstruction means something. The same holds
for the reply and the opt-out, which are matched, classified and given their effects by
the same `processMessageIds` the mail sync and the mail recovery both call, so what the
drill's step 4 reapplies is what a real inbox would have produced.

A step that cannot be produced through a real path is a refusal naming the step
(`step_unproducible`), never a raw insert. One row has no domain creator at all — the
`sending_domains` row, for which every exported function in `packages/domain/outbound`
is a read or an update, and `apps/api` has no create route. It is inserted with its
three authentication booleans left at their column defaults, and
`recordAuthenticationChecklist` and `setAutomatedSendingEnabled` then run through the
domain, which is where 12.7's invariant lives and which the table's own CHECK enforces
in any case.

### 2. Seeding lives in the rehearsal only, and two independent guards say so

Production's drill (runbook section 7) runs against real data on a schedule. The sends,
replies and suppressions it reconstructs are a salesperson's, and a fixture in their
place would replace the thing being proved with the thing proving it. So:

* **the command refuses unless `FSS_DEPENDENCIES` is exactly `recorded`**, with exit 20
  and reason `dependencies_not_recorded`, in the same branch and for the same reason
  `fss drill` refuses. It reaches the Gmail seam, and production's worker is `live`;
* **`infra/scripts/release-seed-drill-evidence.sh` refuses any prefix that is not
  `fss-rh-<run>`**, using `rehearsal_require_prefix` — the same guard
  `rehearsal-restore-drill.sh` and `rehearsal-run-task.sh` use. Unlike
  `release-bootstrap-workspace.sh`, which genuinely runs in both environments and asks
  for `--environment production` to prove the operator meant it, this script has no such
  flag: there is nothing to type, so there is nothing to type by mistake.

Neither guard is the other's excuse. `test/release/drillEvidence.check.ts` exercises the
prefix refusal by *running* the script rather than by reading it.

There is one consequence worth naming. The rehearsal root defaults `dependencies_mode`
to `live`, deliberately, so that sign-in rehearses the path production runs — which
means the operations task definition says `live` and the command would refuse. The
script therefore names `FSS_DEPENDENCIES=recorded` as a `release_run_task --env`
override on this one launch. That is the rehearsal choosing the recorded seam out loud,
exactly as the workflow's journal-replay step already does, and it is a public
identifier the wrapper's own `--env` guard permits while refusing anything that looks
like a credential. It is not a way into production, because the prefix guard has already
run.

### 3. The recorded Gmail client is built by the command, not taken from the deployment

`readGmailDeployment` hands a `recorded` deployment one fixed fixture with no messages
in it. That is right for every other caller and useless for a seed whose job is to make
a reply and an opt-out arrive, so the command builds its own `recordedGmailClient` —
the same fake, from the same module, `packages/domain/mail/gmailClientFake.ts` — with a
mutable message list it pushes the two inbound messages onto *after* the send they
answer has happened. Ingesting the reply first would open an `uncertain_reply` hold on
the opportunity and the send would then be refused, which is the system working
correctly and the wrong order to seed in.

Everything else comes from the deployment: the OAuth configuration, the envelope cipher
that wraps the mailbox's refresh token, and the object-locked suppression journal the
opt-out is written to before its row. The journal is the one that matters most — the
operations task runs as the worker task role, which the bucket policy allows to append,
so the drill's step 2 replays objects a real `recordSuppression` wrote.

The refresh token is re-wrapped on **every** run rather than only when the mailbox is
created. `localDataKeyWrapper` generates its master key when the process starts, so a
token wrapped by one task cannot be unwrapped by the next one; `storeRefreshToken` is an
upsert for exactly this case.

### 4. The drill waits for the restorable point to pass the evidence

RDS's `LatestRestorableTime` lags real time by up to about five minutes (spec 4.1). A
target read a moment after the evidence was written is therefore a point *before* the
evidence existed: the restore lands on a database that has none of it, the baseline
measured at that instant is empty, and the drill refuses again — with the seeding step
having run and worked, which is the worst version of this failure because it looks like
the seeding is broken.

So `rehearsal-restore-drill.sh` reads the `asOf` instant out of the report the
before-phase wrote (`drill-evidence-before.txt`) and polls `LatestRestorableTime` until
it is later, bounded at 40 attempts of 15 seconds, with a `FAIL` that names the instant
it was waiting for. The comparison is on fourteen digits rather than on strings, because
`[[ a > b ]]` in bash is a locale collation and this is an ordering of instants. An
operator running the drill by hand against an environment somebody else seeded finds no
report, is told so, and proceeds — the baseline refusal is still the guard.

### 5. `--phase after` runs inside the drill, between the baseline and the restore

0.1 asks for the clock to run past the target "while more activity happens, so the
restore genuinely loses work". That activity has to be later than the baseline and
earlier than the restore, and the workflow has no seam there — the drill is one step.
So the drill script calls the seeding script a second time, with `--phase after`, after
the baseline refusal loop and before `restore-db-instance-to-point-in-time`.

`--phase after` adds a second accepted send and a second ordinary CRM edit **and nothing
else**. A second suppression or a second reply would change what steps 2 and 4 are
reconstructing, and every assertion the drill already made is a floor — "no suppression
was lost", "no send repeated", `suppressions_after >= suppressions_before` — so the
extra send and the extra edit cannot break one whether the restore keeps them or loses
them. The second send is on its own firm, with its own contact, route and opportunity,
because the opt-out suppresses a firm and `sequence_enrollments_one_active_per_contact`
allows one live enrollment per contact.

### 6. Idempotence is a read before every write, reported per item

Every step reads first and reports `created` or `existing`: the firms by the
`record_aliases` external id every run writes, the contacts by name, the routes by
address, the send by the fence its contact already has in `sent`, the two ingested
messages by their fixed provider ids, the manual suppression by `isSuppressed`, and the
CRM edit by whether the firm's name is already the phase's name. A re-run of a phase adds
nothing, which is what makes the step safe to retry inside a workflow that may be
re-dispatched.

## What this does not claim

The drill's step 0 will now pass. Steps 1 to 9 have prerequisites of their own that
section 0.1 does not list, and this lane deliberately did not invent them:

* **step 1** needs `fss admin dial-authorize --any` to find a dialable subject — an
  assigned firm with a *phone* route and a verified, enabled calling identity. This lane
  seeds email routes only, so the step will refuse with `no_dialable_subject`, which is
  the tool declining to report a refusal it did not earn;
* **step 2** needs a journalled suppression the *restore loses*. Both of this lane's
  suppressions are written before the restore target, so the restored database has them
  and `suppression-journal replay` will insert nothing;
* **step 3** needs a fence left in `dispatching` or `reconciling` whose Message-ID the
  Sent folder proves was delivered. This lane's send reaches `sent` in one pass, which
  is what 0.1 asks for and not what step 3 reconciles.

Each is a named, testable gap rather than a surprise, and each is a lane. Relaxing any
of the drill's assertions to accommodate them would be the vacuous pass this whole
document exists to prevent.

## Where this is enforced

* `apps/worker/src/tools/fss/drillEvidence.ts` — the command;
* `apps/worker/src/tools/fss.ts`, `apps/worker/src/tools/fss/commands.ts` — the grammar,
  the runtime identity and the `recorded` refusal;
* `infra/scripts/release-seed-drill-evidence.sh` — the launch and the prefix refusal;
* `infra/scripts/rehearsal-restore-drill.sh` — the wait and the after phase;
* `.github/workflows/greenfield-release.yml` — the `full`-only step and the
  credential-free plan;
* `apps/worker/test/drillEvidence.test.ts` — the five kinds on embedded PostgreSQL,
  idempotence, and the `live` refusal before any write;
* `test/release/drillEvidence.check.ts` — the step order, the wait, the production
  refusal, the wrapper-only launch, and that every existing drill assertion survives;
* `scripts/releaseMutationCheck.mjs` — removing the production refusal from the seeding
  script must turn `npm run test:release` red.
