import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meetingFollowThroughViewV2Schema } from '@fss/contracts';
import { meetingDispatchFixture } from '@fss/domain/test/meetings/support/meetingDispatchFixture.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { runMeetingFollowThrough } from '@fss/domain/meetings/followThroughJobs.ts';
import { dispatchOutboundMessage } from '@fss/domain/outbound/send.ts';
import { saveMeetingNotes } from '@fss/domain/meetings/notes.ts';
import { dispatch, type ApiOptions } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

describe('meeting follow-through through API, scheduler and dispatch', () => {
  let f: Awaited<ReturnType<typeof meetingDispatchFixture>>, auth: AuthFixture;
  let options: ApiOptions, token: string;
  beforeAll(async () => {
    f = await meetingDispatchFixture();
    auth = await createAuthFixture();
    const account = f.world.alpha.workspace.salesperson;
    const user = (await f.db.query<{ google_sub: string; email: string }>(
      'SELECT google_sub,email FROM users WHERE id=$1', [account.userId],
    )).rows[0]!;
    const joined = { ...auth, db: f.db, hostedDomain: 'example.test', deps: { ...auth.deps, db: f.db,
      config: { ...auth.deps.config, oidc: { ...auth.deps.config.oidc, hostedDomain: 'example.test' } } } };
    token = (await issueSessionFor(joined, { ...auth.alpha, workspaceId: f.workspace, slug: f.world.alpha.workspace.slug },
      { googleSub: user.google_sub, email: user.email })).accessToken;
    options = { session: f.db, auth: joined.deps, supportedClientVersions: joined.deps.config.supportedClientVersions,
      sendingEnabled: false, upgradeUrl: 'https://example.test/update' };
  }, 180_000);
  afterAll(async () => { await auth?.stop(); await f?.world.stop(); });

  async function request(method: 'GET' | 'POST', path: string, body?: Readonly<Record<string, unknown>>) {
    const address = new URL(path, 'https://example.test');
    return await dispatch({ method, path: address.pathname, query: address.searchParams,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : { ...body, clientVersion: CURRENT_CLIENT_VERSION },
    }, options);
  }
  async function read() {
    const answer = await request('GET', `/meetings/follow-through?meetingId=${f.meetingId}&version=2`);
    expect(answer.status).toBe(200);
    return meetingFollowThroughViewV2Schema.parse(answer.body);
  }
  async function save(path: string, input: Readonly<Record<string, unknown>>) {
    const answer = await request('POST', `${path}?version=2`, input);
    expect(answer.status).toBe(200);
    const envelope = answer.body as { result: unknown; replayed: boolean };
    return { view: meetingFollowThroughViewV2Schema.parse(envelope.result), replayed: envelope.replayed };
  }

  it('round-trips four held unpublished drafts with replay, conflicts and legacy compatibility', async () => {
    const current = await read();
    const counts = async () => (await f.db.query(`SELECT (SELECT count(*) FROM sequence_enrollments) AS enrollments,
      (SELECT count(*) FROM outbound_messages) AS outbound,(SELECT count(*) FROM follow_up_permissions) AS permissions`)).rows[0];
    const before = await counts();
    const input = { meetingId: f.meetingId, expectedSourceHash: current.sourceHash,
      expectedNotesRevision: current.notesRevision, expectedPlanVersion: current.version, expectedUnpublishedRevision: 0, commandId: randomUUID(),
      messages: [{ subject: 'Fixture recap', body: 'Known controlled note. Date {day}.' }, { subject: '', body: '' },
        { subject: 'Question', body: '{their question}' }, { subject: 'Final fixture draft', body: '' }] };
    const saved = await save('/meetings/unpublished-plan', input);
    expect(saved.view.unpublishedPlan!.messages.map(m => m.elapsedDays)).toEqual([0, 3, 7, 14]);
    expect(saved.view.unpublishedPlan!.messages.every(m => m.held)).toBe(true);
    expect(await save('/meetings/unpublished-plan', input)).toEqual({ ...saved, replayed: true });
    expect(await read()).toEqual(saved.view);
    const conflict = await request('POST', '/meetings/unpublished-plan?version=2', { ...input, commandId: randomUUID() });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ reason: 'draft_changed' });
    const legacy = await request('GET', `/meetings/follow-through?meetingId=${f.meetingId}`);
    expect(legacy.status).toBe(200);
    expect(legacy.body).not.toHaveProperty('unpublishedPlan');
    expect(await counts()).toEqual(before);
  });

  it('persists the edited recap and makes zero provider calls while paused', async () => {
    const fence = await f.prepare();
    await f.db.query('UPDATE sending_domains SET automated_sending_enabled=false,automated_sending_enabled_at=NULL WHERE workspace_id=$1', [f.workspace]);
    const current = await read();
    expect(current.sendingPaused).toBe(true);
    const begun = await save('/meetings/recap/edit', { planId: current.planId, expectedPlanVersion: current.version,
      expectedDraftVersion: current.currentDraft!.version, action: 'begin_edit', commandId: randomUUID() });
    expect(begun.view.currentDraft!.state).toBe('editing');
    const body = 'Updated controlled recap.\n\nSigned off';
    const saved = await save('/meetings/recap/edit', { planId: begun.view.planId, expectedPlanVersion: begun.view.version,
      expectedDraftVersion: begun.view.currentDraft!.version, action: 'save', subject: 'Meeting follow-up', body, commandId: randomUUID() });
    expect(saved.view.currentDraft!.body).toBe(body);
    await withTransaction(f.db, () => runMeetingFollowThrough(f.context, { meetingId: f.meetingId, at: f.at }));
    const gmail = f.world.clientWith(f.world.alpha, {});
    await dispatchOutboundMessage(f.context, f.world.sendDeps(f.world.alpha, { gmail, now: () => new Date(f.at) }), { outboundMessageId: fence.id });
    expect(gmail.sends).toHaveLength(0);
    expect(await read()).toMatchObject({ sendingPaused: true, currentDraft: { body } });
  });

  it('refuses stale notes, accepts an explicit current binding and prevents replay resurrection after deletion', async () => {
    const current = await read();
    const input = { meetingId: f.meetingId, commandId: randomUUID(), expectedSourceHash: current.draftSource!.sourceHash,
      expectedNotesRevision: current.draftSource!.notesRevision, expectedPlanVersion: current.version,
      expectedUnpublishedRevision: current.unpublishedPlan!.revision,
      messages: [{ subject: 'Fixture correction', body: 'Typed human fixture text {day}' }, { subject: '', body: '' },
        { subject: '', body: '' }, { subject: '', body: '' }] };
    const notes = await withTransaction(f.db, () => saveMeetingNotes(f.admin, { meetingId: f.meetingId,
      expectedRevision: input.expectedNotesRevision, debrief: 'Corrected controlled fixture notes', sufficient: true,
      speakerMappings: [], itemOverrides: [] }));
    expect(notes.ok).toBe(true);
    const stale = await request('POST', '/meetings/unpublished-plan?version=2', input);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ reason: 'source_changed' });
    const fresh = await read();
    expect(fresh.sourceHash).toBe(current.sourceHash);
    const rebased = { ...input, commandId: randomUUID(), expectedSourceHash: fresh.draftSource!.sourceHash,
      expectedNotesRevision: fresh.draftSource!.notesRevision };
    const saved = await save('/meetings/unpublished-plan', rebased);
    expect(saved.view.unpublishedPlan!.messages[0].body).toBe(input.messages[0]!.body);
    expect(saved.view.unpublishedPlan!.messages.every(message => message.held)).toBe(true);
    expect(await save('/meetings/unpublished-plan', rebased)).toEqual({ ...saved, replayed: true });
    await f.db.query('DELETE FROM meetings WHERE workspace_id=$1 AND id=$2', [f.workspace, f.meetingId]);
    for (const answer of [await request('POST', '/meetings/unpublished-plan?version=2', rebased),
      await request('GET', `/meetings/follow-through?meetingId=${f.meetingId}&version=2`)]) {
      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ error: 'not_found' });
    }
    expect((await f.db.query('SELECT id FROM meeting_follow_through WHERE meeting_id=$1', [f.meetingId])).rows).toHaveLength(0);
  });
});
