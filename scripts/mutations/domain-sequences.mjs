// Release mutations that edit the sequence engine (`packages/domain/sequences/`).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
  {
    name: 'the held-enrollment gauge ignores the open holds and counts only steps the worker already held',
    file: 'packages/domain/sequences/metrics.ts',
    find: '                        AND h.released_at IS NULL\n',
    replace: '                        AND false\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/sequences/enrollmentGauges.test.ts'],
    because:
      'Counting held step executions is the plausible shortcut, and it is wrong exactly when the alarm matters: a step is held only once it comes due and the worker tries it, so under a restore, a mailbox-health hold or a send nobody can account for, every enrollment waiting for next week\u2019s step reads as running and all-sequences-held never reaches 1. enrollmentGauges.test.ts counts enrollment, firm, opportunity, owner and workspace holds over steps that are still pending and has to go red.',
  },
  {
    name: 'the active-enrollment gauge counts a completed enrollment as active',
    file: 'packages/domain/sequences/metrics.ts',
    find: '          WHERE n.ended_at IS NULL\n',
    replace: "          WHERE n.state <> 'stopped'\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/sequences/enrollmentGauges.test.ts'],
    because:
      'Excluding only terminal stops forgets that a plan which ran out is also over. Every completed enrollment then sits in the denominator forever, and the held fraction can never reach 1 once any sequence has finished, so the critical alarm is silenced by success. enrollmentGauges.test.ts completes one enrollment, stops another, expects one active and has to go red.',
  },
  {
    name: 'a dispatched step is nothing to do again, so a dead worker’s prepared fence stays prepared',
    file: 'packages/domain/sequences/executions.ts',
    find: "  if (loaded.state !== 'pending' && loaded.state !== 'held' && loaded.state !== 'dispatched') {\n",
    replace: "  if (loaded.state !== 'pending' && loaded.state !== 'held') {\n",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/sequenceActionRearm.test.ts'],
    because:
      'This is audit C03: the step’s transaction commits `dispatched` with the fence, the claim comes after, and a worker killed in between left a retry that read `dispatched`, did nothing and completed. sequenceActionRearm.test.ts kills the backend inside the claiming transaction and requires the retry, and the scheduler’s recovery wake, to send once; treating `dispatched` as finished sends nothing and it has to go red.',
  },
  {
    name: 'the wake takes pending work only, so a released hold never wakes the step it blocked',
    file: 'packages/domain/sequences/wake.ts',
    find: "               AND (e.state = 'pending' OR NOT ${BLOCKING_HOLD_SQL}))\n",
    replace: "               AND e.state = 'pending')\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/sequences/wake.test.ts'],
    because:
      'This is audit C05: releasing a hold only stamped released_at and nothing ever asked about the held step again. wake.test.ts requires an unblocked held step, and a step whose hold of each scope was just released, to be woken; with held work never woken it has to go red.',
  },
  {
    name: 'a woken held step skips the resume and runs without 4.3’s shift',
    file: 'packages/domain/sequences/executions.ts',
    find: "    const resumed = await resumeHeldStep(context, execution, input.now);\n    if (resumed.kind === 'stopped') return resumed.outcome;\n    execution = resumed.execution;\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/sequenceActionRearm.test.ts'],
    because:
      'Audit C05 is also the resume: 4.3 shifts the unexecuted steps by the union of the holds that just cleared, or sends a long hold to review, before the fresh check. sequenceActionRearm.test.ts releases a two-hour pause and requires one hold_union shift of two hours on the step it sends; without the resume the step goes with no shift and it has to go red.',
  },
  {
    name: 'a step an open hold blocks is pushed an hour out, so the release does not wake it on the next pass',
    file: 'packages/domain/sequences/executions.ts',
    find: '            not_before = CASE WHEN ${BLOCKING_HOLD_SQL}\n                              THEN e.not_before\n',
    replace: '            not_before = CASE WHEN false\n                              THEN e.not_before\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/sequences/rearm.test.ts'],
    because:
      'The wake skips a step while an open hold blocks it, so the step’s not_before must stay where it was for the first pass after the release to take it. rearm.test.ts holds a step behind an uncertain-reply hold and requires its not_before unchanged; pushed out by the recheck interval it has to go red.',
  },
  {
    name: 'every resume counts every hold since the enrollment began again',
    file: 'packages/domain/sequences/resume.ts',
    find: '    since: await resumeWindowStart(context, enrollment),\n',
    replace: '    since: enrollment.startedAt,\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/sequences/rearm.test.ts'],
    because:
      'This is audit C09: a second release shifted the steps by the first hold again, because the union was taken from the enrollment’s start every time. rearm.test.ts applies a one-day pause and then a two-hour one and requires the second shift to be two hours; from the start it is twenty-six and it has to go red.',
  },
  {
    name: 'the hold scopes the wake and the resume ask lose the owner’s mailbox',
    file: 'packages/domain/sequences/wake.ts',
    find: "                OR (${alias}.scope_kind = 'mailbox' AND ${alias}.scope_key = ${subject.mailboxId})\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/sequences/wake.test.ts'],
    because:
      'This is audit C10: the resume asked five scopes of seven while eligibility (lane g77) asks all of them, so a mailbox pause refused the step and neither shifted it nor kept the scheduler from preparing it every pass. wake.test.ts runs a hold of each scope through holdSource, the wake and the resume and requires one answer; without the mailbox arm the wake takes a step eligibility refuses and it has to go red.',
  },
  {
    name: 'a step’s own fence’s cap hold keeps the step asleep for ever',
    file: 'packages/domain/sequences/wake.ts',
    find: "         AND NOT (h.source_event_kind = 'outbound_message'\n                  AND EXISTS (SELECT 1 FROM outbound_messages f\n                               WHERE f.workspace_id = e.workspace_id AND f.step_execution_id = e.id\n                                 AND f.id::text = h.source_event_id))\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/sequences/wake.test.ts'],
    because:
      'A capped fence opens a firm hold, and only the fence’s own next dispatch releases it; if that hold blocked its own step’s wake, the step would wait for a release that only it can bring. wake.test.ts requires the step with the capped fence to be woken while its neighbour at the firm is not; counting the own-fence hold keeps it asleep and it has to go red.',
  },
  {
    name: 'the successor of a late step is the plan again, due the hour the late step went',
    file: 'packages/domain/sequences/successor.ts',
    find: "  if (Date.parse(floor.dueAt) <= Date.parse(plan.dueAt)) return { ...plan, anchor: 'plan' };\n",
    replace: "  if (floor.dueAt.length > 0) return { ...plan, anchor: 'plan' };\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/sequences/rearm.test.ts'],
    because:
      'This is audit C11: the original dispatch time became completed_at and nothing read it, so an email that went Thursday was followed by a call planned for Wednesday, due at once. rearm.test.ts sends the Monday email on Thursday and requires the call on Monday 28 September from the dispatch instant; with the plan alone it is Wednesday and it has to go red.',
  },
  {
    name: 'a woken step’s held fence is read, not dispatched, and stays held',
    file: 'packages/domain/sequences/executions.ts',
    find: "  if (fence.state === 'prepared' || fence.state === 'held') {\n    const dispatched = await input.sendHandoff.dispatch(context, {\n",
    replace: "  if (fence.state === 'prepared') {\n    const dispatched = await input.sendHandoff.dispatch(context, {\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/stepWake.test.ts'],
    because:
      'A fence the cap held never entered dispatching, and the dispatch path is what releases it and decides again (g7-held-returns-to-prepared). stepWake.test.ts holds a step’s fence on the cap, lifts the cap and requires the next look to send it through held, prepared, dispatching and sent; if only prepared fences are dispatched the fence stays held and it has to go red.',
  },
  {
    name: 'the resume review shows no shift for a hold long enough to need one',
    file: 'packages/domain/sequences/resume.ts',
    find: "  const shift = decision.kind === 'still_held' ? 0 : confirmedShiftMilliseconds(decision, composition);\n",
    replace: "  const shift = decision.kind === 'resume' ? decision.shiftMilliseconds : 0;\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/sequences/resumePreview.test.ts'],
    because:
      'Audit item G06: the review is only worth reading if its dates are the dates the confirmation applies. A review of a nine-day hold that proposed the current dates would be confirmed and then move every step nine days. resumePreview.test.ts requires the proposed instant to be the one the confirmation writes and has to go red.',
  },
];
