import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { applyStageEvidence } from '../../crm/stageEvidence.ts';
import { changeStage, openOpportunity } from '../../crm/pipeline.ts';
import { readPipelineBoardForActor } from '../../crm/board.ts';
import { setOpportunityValue } from '../../crm/opportunityValue.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * What the Kanban (slice K) reads beyond slice W's card: the evidence only while the
 * automatic move is the latest one, the close reason of a Lost card, every stage for
 * "Move to…", and a person's value with its assignee-or-admin authorization.
 */
describe('Kanban board read and value command', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let system: RepositoryContext;
  let assignee: RepositoryContext;
  let counter = 0;

  async function opportunity(): Promise<{ firmId: string; opportunityId: string }> {
    counter += 1;
    const { rows } = await database.session.query<{ id: string }>(
      'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
      [seeded.alpha.workspaceId, `Kanban Firm ${String(counter)}`, seeded.alpha.salesperson.userId],
    );
    const firmId = rows[0]?.id ?? '';
    const opened = await openOpportunity(system, { firmId, stageKey: 'new' });
    if (!opened.ok) throw new Error(opened.reason);
    return { firmId, opportunityId: opened.value.id };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    system = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);
    assignee = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      database.session,
    );
  });
  afterAll(async () => {
    await database.drop();
  });

  it('shows the evidence of an automatic move, and hides it once a person moves the card', async () => {
    const { firmId, opportunityId } = await opportunity();
    await applyStageEvidence(system, {
      opportunityId,
      evidenceKind: 'meeting.booked',
      evidenceId: 'k-1',
      occurredAt: '2026-09-30T15:00:00.000Z',
    });
    expect((await readPipelineBoardForActor(assignee)).cards[firmId]?.evidence).toMatchObject({ kind: 'meeting.booked', fromStageKey: 'new' });

    // A later manual move is the card's latest move: the booking no longer explains it.
    expect((await changeStage(assignee, { opportunityId, toStageKey: 'qualified' })).ok).toBe(true);
    const card = (await readPipelineBoardForActor(assignee)).cards[firmId];
    expect(card?.evidence).toBeNull();
    expect(card?.pinned).toBe(true);
  });

  it('carries the close reason of a Lost card, every stage, and nothing else about Lost while filtered', async () => {
    const { firmId, opportunityId } = await opportunity();
    expect((await changeStage(assignee, { opportunityId, toStageKey: 'lost', reason: 'chose a competitor' })).ok).toBe(true);
    const hidden = await readPipelineBoardForActor(assignee);
    expect(hidden.cards[firmId]).toBeUndefined();
    expect(hidden.stages.map(stage => stage.key)).toContain('lost');
    expect(hidden.columns.map(column => column.stage.key)).not.toContain('lost');
    const shown = await readPipelineBoardForActor(assignee, { includeLost: true });
    expect(shown.cards[firmId]?.closeReason).toBe('chose a competitor');
  });

  it('records a person\'s value for the assignee, refuses another salesperson, and shows it on the card', async () => {
    const { firmId, opportunityId } = await opportunity();
    expect(await setOpportunityValue(assignee, { opportunityId, monthlyCents: 50_000, kind: 'agreed' })).toEqual({
      ok: true,
      value: { opportunityId },
    });
    expect((await readPipelineBoardForActor(assignee)).cards[firmId]?.value).toEqual({ monthlyCents: 50_000, kind: 'agreed' });
    const { rows } = await database.session.query<{ source: string; recorded_by_user_id: string }>(
      'SELECT source, recorded_by_user_id FROM opportunity_values WHERE opportunity_id = $1',
      [opportunityId],
    );
    expect(rows).toEqual([{ source: 'person', recorded_by_user_id: seeded.alpha.salesperson.userId }]);

    const other = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'salesperson' }),
      database.session,
    );
    expect(await setOpportunityValue(other, { opportunityId, monthlyCents: 1, kind: 'agreed' })).toEqual({ ok: false, reason: 'not_assigned' });
    expect(await setOpportunityValue(assignee, { opportunityId, monthlyCents: -1, kind: 'agreed' })).toEqual({ ok: false, reason: 'invalid_input' });
  });
});
