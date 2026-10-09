import { applyStageEvidence } from '../../crm/stageEvidence.ts';
import { createContact } from '../../crm/contacts.ts';
import { bridgeLegacyContacts, addSelectedSource, readPerson } from '../../crm/people.ts';
import { saveRelationship, saveSourceContext, readSourceContexts } from '../../crm/relationships.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { applyBooked } from '../../meetings/calcom.ts';
import { createFirm } from '../../crm/firms.ts';
import { mergeFirms } from '../../crm/merges.ts';
import { withTransaction } from '../../db/queryable.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { expect, it } from 'vitest';
import { createTestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces } from '../db/support/fixtures.ts';
import { readPluralFirmPage, readFirmPage } from '../../crm/firmPage.ts';
import { readFirmForActor } from '../../crm/dto.ts';
import { readPluralPipelineBoardForActor, readPipelineBoardForActor } from '../../crm/board.ts';
import {
  openExplicitOpportunity,
  openOpportunity,
  changeStage,
  readOpportunity,
  readOpenOpportunity,
  reopenExplicitOpportunity,
} from '../../crm/pipeline.ts';

it('an assignee explicitly opens two manual deals and changes only the selected stage', async () => {
  const db = await createTestDatabase();
  try {
    const seeded = await seedTwoWorkspaces(db.session);
    const context = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      db.session,
    );
    const firmId = (
      await db.session.query<{ id: string }>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id', [
        seeded.alpha.workspaceId,
        'Two independent pilots',
        seeded.alpha.salesperson.userId,
      ])
    ).rows[0]?.id;
    if (!firmId) throw new Error('firm fixture failed');
    const a = await openExplicitOpportunity(context, { firmId, name: 'Portfolio pilot' });
    const b = await openExplicitOpportunity(context, { firmId });
    if (!a.ok || !b.ok) throw new Error('explicit create refused');
    expect(a.value.id).not.toBe(b.value.id);
    expect(a.value.control_mode).toBe('manual');
    expect(b.value.control_mode).toBe('manual');
    expect((await changeStage(context, { opportunityId: a.value.id, toStageKey: 'qualified', expectedStageKey: 'new' })).ok).toBe(true);
    const first = await readOpportunity(context, a.value.id);
    const second = await readOpportunity(context, b.value.id);
    expect(first?.stage_id).not.toBe(second?.stage_id);
    expect(second?.status).toBe('open');
    const board = await readPluralPipelineBoardForActor(context);
    expect(Object.keys(board.cards)).toEqual(expect.arrayContaining([a.value.id, b.value.id]));
    expect(board.cards[a.value.id]?.firm.id).toBe(firmId);
    expect(board.cards[a.value.id]?.displayName).toBe('Portfolio pilot');
    const page = await readPluralFirmPage(context, { firmId });
    if (!page.ok || page.value.visibility !== 'assigned_or_admin') throw new Error('plural page refused');
    expect(page.value.opportunities.map((item) => item.opportunity.id)).toEqual(expect.arrayContaining([a.value.id, b.value.id]));
    expect(page.value.opportunities.find((item) => item.opportunity.id === a.value.id)?.stageHistory.at(-1)?.toStageKey).toBe('qualified');
    expect(page.value.opportunities.find((item) => item.opportunity.id === b.value.id)?.stageHistory.at(-1)?.toStageKey).toBe('new');
    expect(board.columns.find((column) => column.stage.key === 'qualified')?.opportunityIds).toContain(a.value.id);
    expect(board.columns.find((column) => column.stage.key === 'new')?.opportunityIds).toContain(b.value.id);
    await db.session.query(
      `INSERT INTO meetings(workspace_id,booking_uid,current_booking_uid,firm_id,opportunity_id,state,starts_at,ends_at,last_event_at) VALUES($1,'plural-booking','plural-booking',$2,$3,'booked',now()+interval '1 day',now()+interval '2 days',now())`,
      [seeded.alpha.workspaceId, firmId, b.value.id],
    );
    const bookedBoard = await readPluralPipelineBoardForActor(context);
    expect(bookedBoard.cards[a.value.id]?.stageSuggestion).toBeNull();
    expect(bookedBoard.cards[b.value.id]?.stageSuggestion?.opportunityId).toBe(b.value.id);
    expect(await openOpportunity(context, { firmId })).toMatchObject({ ok: false });
    expect(await readOpenOpportunity(context, firmId)).toBeNull();
    expect(await readFirmForActor(context, { firmId })).toMatchObject({ ok: false, reason: 'opportunity_ambiguous' });
    await expect(readPipelineBoardForActor(context)).rejects.toThrow('opportunity_ambiguous');
    expect((await changeStage(context, { opportunityId: a.value.id, toStageKey: 'lost', reason: 'pilot paused' })).ok).toBe(true);
    const reopened = await reopenExplicitOpportunity(context, { firmId, opportunityId: a.value.id, reason: 'new pilot scope' });
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(reopened.value.reopenedFrom).toBe(a.value.id);
    expect((await readPluralPipelineBoardForActor(context)).cards[reopened.value.opportunityId]?.displayName).toBe('Portfolio pilot');
    expect((await readOpportunity(context, b.value.id))?.status).toBe('open');
    expect((await readOpportunity(context, reopened.value.opportunityId))?.control_mode).toBe('manual');
  } finally {
    await db.drop();
  }
});

it('firm merging preserves both open initiatives and their independent histories', async () => {
  const db = await createTestDatabase();
  try {
    const seeded = await seedTwoWorkspaces(db.session);
    const context = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      db.session,
    );
    const source = await createFirm(context, { name: 'Source initiative firm' }),
      target = await createFirm(context, { name: 'Target initiative firm' });
    if (!source.ok || !target.ok) throw new Error('firm fixture failed');
    const a = await openExplicitOpportunity(context, { firmId: source.value.id }),
      b = await openExplicitOpportunity(context, { firmId: target.value.id });
    if (!a.ok || !b.ok) throw new Error('deal fixture failed');
    const merged = await withTransaction(db.session, () =>
      mergeFirms(context, { sourceFirmId: source.value.id, targetFirmId: target.value.id, journal: recordingSuppressionJournal() }),
    );
    expect(merged.ok).toBe(true);
    const page = await readPluralFirmPage(context, { firmId: target.value.id });
    if (!page.ok || page.value.visibility !== 'assigned_or_admin') throw new Error('merged page unavailable');
    expect(page.value.opportunities.map((item) => ({ id: item.opportunity.id, status: item.opportunity.status }))).toEqual(
      expect.arrayContaining([
        { id: a.value.id, status: 'open' },
        { id: b.value.id, status: 'open' },
      ]),
    );
    expect(page.value.opportunities.find((item) => item.opportunity.id === a.value.id)?.stageHistory).toHaveLength(1);
    expect((await changeStage(context, { opportunityId: a.value.id, toStageKey: 'won', expectedStageKey: 'new' })).ok).toBe(true);
    expect((await readOpportunity(context, b.value.id))?.status).toBe('open');
    expect(
      (
        await changeStage(context, {
          opportunityId: b.value.id,
          toStageKey: 'lost',
          expectedStageKey: 'new',
          reason: 'Different initiative ended',
        })
      ).ok,
    ).toBe(true);
    const outcomes = await readPluralFirmPage(context, { firmId: target.value.id });
    if (!outcomes.ok || outcomes.value.visibility !== 'assigned_or_admin') throw Error('page');
    expect(
      outcomes.value.opportunities.map((entry) => ({
        id: entry.opportunity.id,
        status: entry.opportunity.status,
        mode: entry.stageControlMode,
      })),
    ).toEqual(
      expect.arrayContaining([
        { id: a.value.id, status: 'won', mode: 'human' },
        { id: b.value.id, status: 'lost', mode: 'human' },
      ]),
    );
  } finally {
    await db.drop();
  }
});

it('a booking preserves its explicitly recorded closed initiative rather than rebinding to another open deal', async () => {
  const db = await createTestDatabase();
  try {
    const seeded = await seedTwoWorkspaces(db.session);
    const context = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      db.session,
    );
    const firm = await createFirm(context, { name: 'Booking context firm' });
    if (!firm.ok) throw new Error(firm.reason);
    const a = await openExplicitOpportunity(context, { firmId: firm.value.id }),
      b = await openExplicitOpportunity(context, { firmId: firm.value.id });
    if (!a.ok || !b.ok) throw new Error('deal fixture failed');
    const meetingId = '11111111-1111-4111-8111-111111111111';
    await db.session.query(
      `INSERT INTO meetings(workspace_id,id,booking_uid,current_booking_uid,firm_id,opportunity_id,state,starts_at,ends_at,last_event_at) VALUES($1,$2,'kept-booking','kept-booking',$3,$4,'booked',now()+interval '1 day',now()+interval '2 days',now())`,
      [seeded.alpha.workspaceId, meetingId, firm.value.id, b.value.id],
    );
    expect((await changeStage(context, { opportunityId: b.value.id, toStageKey: 'lost', reason: 'original pilot ended' })).ok).toBe(true);
    await withTransaction(db.session, () => applyBooked(context, { id: meetingId, firm_id: firm.value.id, booking_uid: 'kept-booking' }));
    const board = await readPluralPipelineBoardForActor(context, { includeLost: true });
    expect(board.cards[b.value.id]?.meeting?.meetingId).toBe(meetingId);
    expect(board.cards[a.value.id]?.meeting).toBeNull();
  } finally {
    await db.drop();
  }
});

it('an explicitly selected incoming call changes its deal control without choosing the other open deal', async () => {
  const db = await createTestDatabase();
  try {
    const seeded = await seedTwoWorkspaces(db.session);
    const context = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      db.session,
    );
    const firmId = (
      await db.session.query<{ id: string }>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id', [
        seeded.alpha.workspaceId,
        'Selected call initiative',
        seeded.alpha.salesperson.userId,
      ])
    ).rows[0]?.id;
    if (!firmId) throw new Error('firm fixture failed');
    const a = await openOpportunity(context, { firmId }),
      b = await openExplicitOpportunity(context, { firmId });
    if (!a.ok || !b.ok) throw new Error('deal fixture failed');
    const logged = await withTransaction(db.session, () =>
      logCallOutcome(context, { firmId, opportunityId: a.value.id, direction: 'inbound', outcome: 'interested' }),
    );
    expect(logged.ok).toBe(true);
    expect((await readOpportunity(context, a.value.id))?.control_mode).toBe('manual');
    expect((await readOpportunity(context, b.value.id))?.control_mode_reason).toBe('explicit opportunity creation');
  } finally {
    await db.drop();
  }
});

it('plural cards keep a callback on its recorded deal and a lost deal does not make the firm unplaced', async () => {
  const db = await createTestDatabase();
  try {
    const seeded = await seedTwoWorkspaces(db.session);
    const context = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      db.session,
    );
    const firm = await createFirm(context, { name: 'Callback firm' });
    if (!firm.ok) throw Error('fixture');
    const a = await openExplicitOpportunity(context, { firmId: firm.value.id }),
      b = await openExplicitOpportunity(context, { firmId: firm.value.id });
    if (!a.ok || !b.ok) throw Error('fixture');
    await db.session.query(
      `INSERT INTO callbacks(workspace_id,firm_id,opportunity_id,assigned_user_id,requested_local_date,source_time_zone,due_at,confirmed_at,confirmed_by_user_id) VALUES($1,$2,$3,$4,current_date,'America/New_York',now()+interval '1 hour',now(),$4)`,
      [seeded.alpha.workspaceId, firm.value.id, a.value.id, seeded.alpha.admin.userId],
    );
    const both = await readPluralPipelineBoardForActor(context);
    expect(both.cards[a.value.id]?.nextAction?.kind).toBe('callback');
    expect(both.cards[b.value.id]?.nextAction).toBeNull();
    expect((await changeStage(context, { opportunityId: b.value.id, toStageKey: 'lost', reason: 'Ended second initiative' })).ok).toBe(
      true,
    );
    const filtered = await readPluralPipelineBoardForActor(context, { includeLost: false });
    expect(filtered.unplacedFirms.map((entry) => entry.id)).not.toContain(firm.value.id);
    const legacy = await readFirmPage(context, { firmId: firm.value.id });
    if (!legacy.ok || legacy.value.visibility !== 'assigned_or_admin') throw Error('legacy unavailable');
    expect(legacy.value.stageHistory).toHaveLength(1);
    expect(legacy.value.stageHistory[0]?.toStageKey).toBe('new');
  } finally {
    await db.drop();
  }
});

it('merging operational contacts preserves original relationship context and does not give the target assignee private copied evidence', async () => {
  const db = await createTestDatabase();
  try {
    const seeded = await seedTwoWorkspaces(db.session);
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      db.session,
    );
    const owner = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      db.session,
    );
    await db.session.query(`INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'salesperson','active')`, [
      seeded.alpha.workspaceId,
      seeded.beta.salesperson.userId,
    ]);
    const targetActor = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.beta.salesperson.userId, role: 'salesperson' }),
      db.session,
    );
    const source = await createFirm(admin, { name: 'Original context', assignedUserId: seeded.alpha.salesperson.userId }),
      target = await createFirm(admin, { name: 'Separate assignee', assignedUserId: seeded.beta.salesperson.userId });
    if (!source.ok || !target.ok) throw Error('fixture');
    const contact = await createContact(owner, { firmId: source.value.id, fullName: 'Private source person' });
    if (!contact.ok) throw Error('fixture');
    expect((await bridgeLegacyContacts(owner, [contact.value.id])).ok).toBe(true);
    expect(
      (
        await addSelectedSource(owner, {
          personId: contact.value.id,
          sourceKey: 'original-private-copy',
          excerpt: 'Original private context',
          occurredAt: '2026-10-08T12:00:00Z',
        })
      ).ok,
    ).toBe(true);
    const selected = (await readPerson(owner, contact.value.id))?.sources[0];
    if (!selected?.contentHash) throw Error('fixture');
    const evidence = { sourceId: selected.sourceId, sourceRevision: selected.revision, contentHash: selected.contentHash };
    const relationship = await saveRelationship(owner, {
      commandId: '11111111-1111-4111-8111-111111111111',
      clientVersion: '1.4.0',
      personId: contact.value.id,
      firmId: source.value.id,
      status: 'current',
      startDate: null,
      endDate: null,
      evidence,
    });
    if (!relationship.ok || !relationship.value.relationshipId) throw Error('fixture');
    expect(
      (
        await saveSourceContext(owner, {
          personId: contact.value.id,
          relationshipId: relationship.value.relationshipId,
          relationshipRevision: 1,
          evidence,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await withTransaction(db.session, () =>
          mergeFirms(admin, { sourceFirmId: source.value.id, targetFirmId: target.value.id, journal: recordingSuppressionJournal() }),
        )
      ).ok,
    ).toBe(true);
    expect((await readPerson(targetActor, contact.value.id))?.sources).toEqual([]);
    expect((await readSourceContexts(admin, { personId: contact.value.id, limit: 50 }))?.contexts).toEqual([
      expect.objectContaining({ firmId: source.value.id, relationshipRevision: 1, sourceId: selected.sourceId }),
    ]);
  } finally {
    await db.drop();
  }
});

it('new explicit deals keep commercial stages manual even when booked-meeting evidence names their exact context', async () => {
  const db = await createTestDatabase();
  try {
    const seeded = await seedTwoWorkspaces(db.session);
    const context = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      db.session,
    );
    const system = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), db.session);
    const firm = await createFirm(context, { name: 'Manual stages' });
    if (!firm.ok) throw Error('fixture');
    const deal = await openExplicitOpportunity(context, { firmId: firm.value.id });
    if (!deal.ok) throw Error('fixture'); // Controlled repair fixture models an outreach-control transition independently of commercial stage authority.
    await db.session.query("UPDATE opportunities SET control_mode='automated',control_mode_origin=NULL WHERE workspace_id=$1 AND id=$2", [
      seeded.alpha.workspaceId,
      deal.value.id,
    ]);
    const evidence = await applyStageEvidence(system, {
      opportunityId: deal.value.id,
      firmId: firm.value.id,
      evidenceKind: 'meeting.booked',
      evidenceId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-09T12:00:00Z',
    });
    expect(evidence).toMatchObject({ kind: 'unchanged', reason: 'manual_stage' });
    const page = await readPluralFirmPage(context, { firmId: firm.value.id });
    if (!page.ok || page.value.visibility !== 'assigned_or_admin') throw Error('fixture');
    expect(page.value.opportunities[0]?.opportunity.stageKey).toBe('new');
    expect(page.value.opportunities[0]?.stageControlMode).toBe('human');
    expect((await openExplicitOpportunity(context,{firmId:firm.value.id})).ok).toBe(true);
    expect(await applyStageEvidence(system,{firmId:firm.value.id,evidenceKind:'meeting.booked',evidenceId:'22222222-2222-4222-8222-222222222222',occurredAt:'2026-10-09T12:00:00Z'})).toMatchObject({kind:'review',reason:'firm_ambiguous'});
  } finally {
    await db.drop();
  }
});
