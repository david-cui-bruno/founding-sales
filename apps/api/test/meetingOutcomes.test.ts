import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
describe('meeting outcomes API', () => {
  let f: AuthFixture, token: string, admin: string, firmId: string, meetingId: string;
  const call = (path: string, body?: unknown, bearer = token, query = new URLSearchParams({ meetingId })) => dispatch({ method: body === undefined ? 'GET' : 'POST', path, query, headers: { authorization: `Bearer ${bearer}` }, body }, {
    session: f.db, auth: f.deps, supportedClientVersions: f.deps.config.supportedClientVersions, sendingEnabled: false, upgradeUrl: 'https://example.test/update',
  });
  beforeAll(async () => {
    f = await createAuthFixture(); token = (await issueSessionFor(f, f.alpha, f.alpha.salesperson)).accessToken; admin = (await issueSessionFor(f, f.alpha, f.alpha.admin)).accessToken;
    firmId = await seedFirm(f, { name: 'Meeting API fixture', regionCode: 'TX', assignedUserId: f.alpha.salesperson.userId }); meetingId = randomUUID();
    await f.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'outcomes-api','outcomes-api','booked',now(),now(),now())", [f.alpha.workspaceId, meetingId, firmId]);
  });
  afterAll(async () => { await f.stop(); });
  it('saves with a revision guard, keeps receipts free of notes, and reauthorizes replay', async () => {
    expect((await call('/meetings/outcomes')).body).toMatchObject({ notes: { revision: 0 }, attendance: 'unconfirmed' });
    const body = { meetingId, expectedRevision: 0, debrief: 'Private human debrief', speakerMappings: [], itemOverrides: [], sufficient: true, commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION };
    expect((await call('/meetings/notes', body)).body).toMatchObject({ result: { revision: 1, debrief: body.debrief } });
    expect((await call('/meetings/notes', body)).body).toMatchObject({ replayed: true, result: { revision: 1 } });
    const receipts = (await f.db.query('SELECT result FROM command_receipts WHERE command_id=$1', [body.commandId])).rows;
    expect(JSON.stringify(receipts)).not.toContain(body.debrief);
    expect((await call('/meetings/notes', { ...body, commandId: randomUUID() })).body).toMatchObject({ reason: 'notes_changed' });
    const newer = { ...body, expectedRevision: 1, debrief: 'A newer saved debrief', commandId: randomUUID() };
    expect((await call('/meetings/notes', newer)).body).toMatchObject({ result: { revision: 2 } });
    expect((await call('/meetings/notes', body)).body).toMatchObject({ reason: 'notes_changed' });
    await f.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId, f.alpha.admin.userId]);
    expect((await call('/meetings/notes', body)).status).toBe(404);
    expect((await call('/meetings/outcomes')).status).toBe(404);
    expect((await call('/meetings/outcomes', undefined, admin)).status).toBe(200);
    await f.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId, f.alpha.salesperson.userId]);
  });
  it('negotiates analysis settings and never enables them automatically', async () => {
    expect((await call('/settings/integrations', undefined, admin)).body).not.toHaveProperty('meetingAnalysis');
    expect((await call('/settings/integrations', undefined, admin, new URLSearchParams({ include: 'meeting_analysis' }))).body).toMatchObject({ meetingAnalysis: { setting: { enabled: false, dailyCeilingCents: 0, creditCoverage: null }, spentTodayCents: 0 } });
  });
  it('completes a meeting task only through its own versioned command', async () => {
    const taskId = randomUUID();
    await f.db.query(`INSERT INTO meeting_tasks(workspace_id,id,meeting_id,firm_id,commitment_id,label,owner_user_id,deadline,due_at,evidence)
      VALUES($1,$2,$3,$4,'api-test','Send guide',$5,'{"precision":"date","localDate":"2026-10-05","zone":"America/New_York"}',now(),'[{"kind":"debrief","revision":1,"quote":"Private","startOffset":0,"endOffset":7}]')`, [f.alpha.workspaceId, taskId, meetingId, firmId, f.alpha.salesperson.userId]);
    const body = { taskId, expectedVersion: 1, action: 'complete', commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION };
    expect((await call('/today/tasks/complete', { taskId, commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION })).status).toBe(409);
    expect((await call('/meetings/tasks/change', body)).body).toMatchObject({ result: { id: taskId, version: 2, status: 'done' } });
    expect((await call('/meetings/tasks/change', body)).body).toMatchObject({ replayed: true, result: { id: taskId, status: 'done' } });
    await f.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId, f.alpha.admin.userId]);
    expect((await call('/meetings/tasks/change', body)).status).toBe(404);
  });
});
