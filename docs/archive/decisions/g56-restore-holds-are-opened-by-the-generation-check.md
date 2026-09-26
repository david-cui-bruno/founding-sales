# g56: restore holds are opened by the generation check

Lane g56, 24 September 2026. Decides who opens `restore_in_progress` holds, how the
operator controls the expected generation, and what the automated restore drill
proves afterwards.

## The gap

Rehearsal run 36062337914 (24 September 2026, 22:45Z) passed step 0 of the restore
drill and stopped at step 1: `holds list --reason restore_in_progress` returned 0.
Nothing in the repository opens a restore hold. `advanceSystemGeneration` releases
them, `listApplicableHolds` and `listOpenHolds` read them, and the worker only logs
`restore_generation_mismatch` when `FSS_EXPECTED_SYSTEM_GENERATION` differs from the
database. No task definition sets that variable. So "the operator-controlled expected
generation" of Appendix E.1 had no control, and a real restore in production would
hold nothing.

A restored copy carries its source's generation, and only step 9 ever moves a
generation. So a restore shows up as a mismatch only when the operator has pinned the
expected generation ahead of the restored copy. The check can't detect a restore on
its own. The operator has to state that one happened.

## Options considered

**Who opens the holds.**

1. *The worker at startup, and nothing else.* This is the branch that already logs
   the event the `RestoreGenerationMismatches` filter counts. It leaves one window
   open. The API serves dial-authorize. During the deployment that points both
   services at a restored database, the API can answer before the worker has started
   and opened anything. A restore that predates a migration is worse: the worker
   refuses the schema range and never reaches the opener.
2. *The API opens holds too.* That closes the window for dialing, but costs a second
   startup write path in a process whose startup does no database work today. It also
   needs a second log event on a log group with no metric filter, and it races the
   worker.
3. *The worker at startup, plus the same code run as an operations command against
   the restored instance before any service points at it.* The holds are rows, and
   every process's gate reads the same rows. So one function run at the right moment
   covers the API without the API changing.

**How the drill gets a mismatch.**

- *Point the rehearsal worker service at the restored host with the variable set.*
  This is the prose route in `restore-drill.md`. It needs a Terraform change or a
  hand-registered task definition mid-run. It runs a full worker, with
  `FSS_DEPENDENCIES=live`, against a database being reconstructed underneath it. It
  also adds a service stabilisation wait, and its log line would come from a process
  the drill doesn't control. Rejected.
- *The drill runs the check itself (chosen).* The drill task is already the one
  process against the restored instance, with `FSS_DEPENDENCIES=recorded` fixed in its
  task definition. It can run the exact function the worker runs and log the exact
  line, into the worker log group, where the metric filter counts it.

**When the operator bumps the pin.** The brief suggested bumping after step 9. That
fails in both orders:

- If the pin still equals the restored copy's generation during steps 1 to 8, nothing
  is held. That is today's failure.
- If services keep the old pin while an explicit command opened the holds, step 9
  moves the database one past the pin. The next worker restart then sees a mismatch
  and reopens restore holds after the release. Releasing those needs another advance,
  which moves the database past the pin again.

## Decision

1. **The opener.** `openRestoreHolds(db, { observedGeneration, expectedGeneration,
   openedBy })` goes in `packages/domain/restore/holds.ts`. Holds are workspace rows
   (`active_holds.workspace_id NOT NULL`) and `listApplicableHolds` matches a
   `workspace`-scope hold for every subject. So the function opens **one
   workspace-scope hold per workspace**, with these fields:
   - `reason_code = restore_in_progress`
   - `blocked_action_kinds = ALL_BLOCKED_ACTION_KINDS`: the restored database acts on
     nothing, including research, until step 9
   - `source_event_kind = restore.generation_mismatch`
   - `source_event_id = <openedBy>:<observed>-><expected>`
   - `recovery_action = advance_generation`

   It does nothing when the two generations are equal. It is idempotent: a workspace
   that already has an open restore hold gets no second one. It runs under
   `pg_advisory_xact_lock`, so two workers starting together can't both insert. It
   touches no other hold, and `advanceSystemGeneration` still releases only these.
2. **The shared check.** `enforceRestoreGeneration` goes in
   `apps/worker/src/bootstrap/restoreGeneration.ts`. It compares, opens the holds in
   one transaction, and logs one `restore_generation_mismatch` line (level `error`,
   expected and observed generation, holds opened and already open). The line is
   written even if the write fails, and the error is then rethrown. Its callers:
   - **the worker**, in `startWorker`'s ready branch. A binary that refuses the
     schema range still writes nothing, per 4.2. A worker that can't hold a restored
     database refuses to start.
   - **a new `fss admin restore-holds open --expected-generation <n>`**, which runs on
     the operations task definition in `database` mode. This is Appendix E step 1 by
     hand, against the restored endpoint, before any service is pointed at it. It
     closes the API window and the pre-migration case.
   - **`fss drill`**, which runs that command as step 1a.

   The API gets no opener (option 3).
3. **The operator control.** `expected_system_generation` (number, default `null` =
   unpinned, validated as a positive integer) is added to `infra/modules/cluster`,
   `infra/modules/stack` and both roots. When it is set, it becomes
   `FSS_EXPECTED_SYSTEM_GENERATION` on the **API and worker service task definitions
   only**. The API already reads it for `/readyz` and `/diagnostics`, and `/readyz`
   isn't the load balancer check. The one-off definitions don't read it, because the
   command takes the generation as a flag. Production stays unpinned in code. Pinning
   it changes two task definitions and rolls both services.
4. **Production protocol (model: pin ahead at step 1).**
   - *Steady state:* pin the current generation. Read it from
     `fss admin counts` → `systemGeneration` (new field), or from the Settings
     diagnostics line.
   - *Restore:*
     1. Read the restored copy's generation R.
     2. Run `fss admin restore-holds open --expected-generation R+1` against the
        restored endpoint.
     3. Set `expected_system_generation = R+1` and apply it in the same apply as, or
        an apply before, whatever points the services at the restored instance.
        Never after.
   - *Step 9:* step 9 advances the database to `max + 1 = R+1`, which equals the pin,
     so no bump is needed. The operator only confirms that step 9's reported
     `generation` equals the pin. If it doesn't, they set the pin to it and apply
     before the next restart.
5. **The drill.**
   - `fss admin counts` also reports `systemGeneration`.
   - The runner refuses a baseline without it, before the restore.
   - The runner launches `fss drill … --expected-generation <baseline systemGeneration + 1>`.
   - Step 1a (`step1a-generation-check`) runs the command and asserts a mismatch and
     at least one hold opened or already in force.
   - Step 1's assertions are unchanged: restore holds ≥ 1 and the dial refused.
   - Step 9 is followed by `step9-generation-reconciled`, which asserts:
     - the advance landed on the expected generation;
     - re-running the check with the same pin reports no mismatch and opens nothing;
     - no restore hold is in force.
   - The runner additionally asserts, straight after the drill and before it judges
     the report, whenever step 1a passed. That way a run that stops later, at step 1's
     dial probe for instance, still proves the alarm:
     - the drill's captured log holds a `restore_generation_mismatch` line;
     - the history of `<prefix>-restore-generation-mismatch` shows a transition to
       `ALARM` since the drill started. The runner polls for up to 5 minutes. The
       alarm is 1 of 1 at 60 s, but treats missing data as not breaching, so by the
       end of a several-minute drill its *current* state is normally back to OK. So
       the check reads the history, not the state.

   `--as-of`, `--baseline` and `--baseline-json` are unchanged, and every existing
   scenario 11 assertion stays.

## What the drill proves afterwards

- A restored database with the operator's pin ahead of it opens restore holds through
  the same function the worker runs at startup.
- Those holds refuse a dial.
- The mismatch reaches the immediately-critical alarm through the real metric filter.
- Advancing the generation releases those holds and no other.
- The pin set at step 1 is the steady state after step 9, so a worker restarted
  afterwards holds nothing.
