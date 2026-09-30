import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { applyStageEvidence, recordOpportunityValue } from '../../crm/stageEvidence.ts';
import { changeStage, openOpportunity } from '../../crm/pipeline.ts';
import { readPipelineBoardForActor } from '../../crm/board.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * `applyStageEvidence`, the one automatic entry point (call-to-booking slice W,
 * acceptance 4): forward only, never a closed opportunity, never over a pin unless the
 * evidence is for a later stage, the same evidence once, and a review item for anything
 * it cannot decide.
 */
describe('applyStageEvidence', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let person: RepositoryContext;
  let system: RepositoryContext;
  let counter = 0;

  const at = '2026-09-30T15:00:00.000Z';

  async function firm(): Promise<string> {
    counter += 1;
    const { rows } = await database.session.query<{ id: string }>(
      'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
      [seeded.alpha.workspaceId, `Evidence Firm ${String(counter)}`, seeded.alpha.salesperson.userId],
    );
    return rows[0]?.id ?? '';
  }

  async function opportunityAt(stageKey: string): Promise<{ firmId: string; opportunityId: string }> {
    const firmId = await firm();
    const opened = await openOpportunity(system, { firmId, stageKey: 'new' });
    if (!opened.ok) throw new Error(opened.reason);
    if (stageKey !== 'new') {
      const moved = await changeStage(system, { opportunityId: opened.value.id, toStageKey: stageKey, reason: 'test' });
      if (!moved.ok) throw new Error(moved.reason);
    }
    return { firmId, opportunityId: opened.value.id };
  }

  async function stageOf(opportunityId: string): Promise<string> {
    const { rows } = await database.session.query<{ key: string }>(
      `SELECT s.key FROM opportunities o JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
        WHERE o.id = $1`,
      [opportunityId],
    );
    return rows[0]?.key ?? '';
  }

  async function pinCount(opportunityId: string): Promise<number> {
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM opportunity_stage_pins WHERE opportunity_id = $1',
      [opportunityId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    person = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      database.session,
    );
    system = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);
  });

  afterAll(async () => {
    await database.drop();
  });

  it('moves an open opportunity forward, once, with its evidence row', async () => {
    const { opportunityId } = await opportunityAt('new');
    const outcome = await applyStageEvidence(system, {
      opportunityId,
      evidenceKind: 'meeting.booked',
      evidenceId: 'meeting-1',
      occurredAt: at,
    });
    expect(outcome).toMatchObject({ kind: 'moved', fromStageKey: 'new', toStageKey: 'demo_booked', pinCleared: false });
    expect(await stageOf(opportunityId)).toBe('demo_booked');

    const again = await applyStageEvidence(system, {
      opportunityId,
      evidenceKind: 'meeting.booked',
      evidenceId: 'meeting-1',
      occurredAt: at,
    });
    expect(again).toEqual({ kind: 'unchanged', opportunityId, reason: 'already_applied' });
    const { rows } = await database.session.query<{ reason: string; actor_kind: string; evidence_id: string }>(
      `SELECT e.reason, e.actor_kind, x.evidence_id FROM opportunity_stage_evidence x
         JOIN opportunity_stage_events e ON e.workspace_id = x.workspace_id AND e.id = x.stage_event_id
        WHERE x.opportunity_id = $1`,
      [opportunityId],
    );
    expect(rows).toEqual([{ reason: 'evidence:meeting.booked', actor_kind: 'worker', evidence_id: 'meeting-1' }]);
  });

  it('never moves an opportunity backward', async () => {
    const { opportunityId } = await opportunityAt('qualified');
    const outcome = await applyStageEvidence(system, {
      opportunityId,
      evidenceKind: 'meeting.booked',
      evidenceId: 'meeting-late',
      occurredAt: at,
    });
    expect(outcome).toEqual({ kind: 'unchanged', opportunityId, reason: 'not_forward' });
    expect(await stageOf(opportunityId)).toBe('qualified');
  });

  it('never moves a closed opportunity, and opens a review item instead of reopening it', async () => {
    const { firmId, opportunityId } = await opportunityAt('lost');
    const byId = await applyStageEvidence(system, {
      opportunityId,
      evidenceKind: 'meeting.booked',
      evidenceId: 'meeting-after-lost',
      occurredAt: at,
    });
    expect(byId).toMatchObject({ kind: 'review', reason: 'opportunity_closed' });
    const byFirm = await applyStageEvidence(system, {
      firmId,
      evidenceKind: 'meeting.booked',
      evidenceId: 'meeting-after-lost-2',
      occurredAt: at,
    });
    expect(byFirm).toMatchObject({ kind: 'review', reason: 'opportunity_closed' });
    expect(await stageOf(opportunityId)).toBe('lost');
    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM opportunities WHERE firm_id = $1 AND status = 'open'",
      [firmId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('does not move a pinned opportunity on earlier-stage evidence, and moves it on later-stage evidence', async () => {
    const { opportunityId } = await opportunityAt('new');
    // A person moves it to Decision pending: that is a pin.
    const moved = await changeStage(person, { opportunityId, toStageKey: 'qualified' });
    expect(moved.ok).toBe(true);
    expect(await pinCount(opportunityId)).toBe(1);
    // A person then moves it back to Interested. The pin follows the person's choice.
    expect((await changeStage(person, { opportunityId, toStageKey: 'new' })).ok).toBe(true);
    expect(await pinCount(opportunityId)).toBe(1);

    // Pinned at Interested: Demo booked is later than the pinned stage, so it moves and
    // clears the pin.
    const pastPin = await applyStageEvidence(system, {
      opportunityId,
      evidenceKind: 'meeting.booked',
      evidenceId: 'pinned-meeting',
      occurredAt: at,
    });
    expect(pastPin).toMatchObject({ kind: 'moved', toStageKey: 'demo_booked', pinCleared: true });
    expect(await pinCount(opportunityId)).toBe(0);

    // Pinned at Onboarding by a person; Demo booked evidence is earlier and does nothing.
    expect((await changeStage(person, { opportunityId, toStageKey: 'onboarding' })).ok).toBe(true);
    const earlier = await applyStageEvidence(system, {
      opportunityId,
      evidenceKind: 'meeting.booked',
      evidenceId: 'another-meeting',
      occurredAt: at,
    });
    expect(earlier).toEqual({ kind: 'unchanged', opportunityId, reason: 'pinned' });
    expect(await stageOf(opportunityId)).toBe('onboarding');
    expect(await pinCount(opportunityId)).toBe(1);

    // Live is later than the pin: it moves, closes the opportunity and clears the pin.
    const later = await applyStageEvidence(system, {
      opportunityId,
      evidenceKind: 'customer.live',
      evidenceId: 'subscription-1',
      occurredAt: at,
    });
    expect(later).toMatchObject({ kind: 'moved', toStageKey: 'won', pinCleared: true });
    expect(await pinCount(opportunityId)).toBe(0);
  });

  it('opens the opportunity at the rule s stage when the firm has none at all', async () => {
    const firmId = await firm();
    const outcome = await applyStageEvidence(system, {
      firmId,
      evidenceKind: 'meeting.booked',
      evidenceId: 'first-contact-meeting',
      occurredAt: at,
    });
    expect(outcome).toMatchObject({ kind: 'opened', toStageKey: 'demo_booked' });
  });

  it('opens a review item for evidence with no rule, once per evidence', async () => {
    const { opportunityId } = await opportunityAt('new');
    const first = await applyStageEvidence(system, {
      opportunityId,
      evidenceKind: 'offer.imagined',
      evidenceId: 'x-1',
      occurredAt: at,
    });
    const second = await applyStageEvidence(system, {
      opportunityId,
      evidenceKind: 'offer.imagined',
      evidenceId: 'x-1',
      occurredAt: at,
    });
    expect(first).toMatchObject({ kind: 'review', reason: 'rule_missing' });
    expect(second).toEqual(first);
  });

  it('shows the move, the value label and the pin on the board card', async () => {
    const { firmId, opportunityId } = await opportunityAt('new');
    expect((await recordOpportunityValue(system, { opportunityId, monthlyCents: 29900, kind: 'estimated', source: 'research' })).ok).toBe(true);
    await applyStageEvidence(system, { opportunityId, evidenceKind: 'meeting.booked', evidenceId: 'board-meeting', occurredAt: at });
    const board = await readPipelineBoardForActor(system);
    const column = board.columns.find(entry => entry.firms.some(entry2 => entry2.id === firmId));
    expect(column?.stage.key).toBe('demo_booked');
    expect(board.cards[firmId]).toEqual({
      value: { monthlyCents: 29900, kind: 'estimated' },
      meeting: null,
      evidence: { kind: 'meeting.booked', evidenceId: 'board-meeting', occurredAt: at, fromStageKey: 'new' },
      pinned: false,
      closeReason: null,
    });
  });
});
