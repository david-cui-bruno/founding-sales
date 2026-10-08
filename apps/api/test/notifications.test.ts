import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { actionableNotificationsResponseSchema, claimNotificationResultSchema, acknowledgeNotificationResultSchema, observeNotificationResultSchema } from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';

let fixture: AuthFixture, token: string, stranger: string;
beforeAll(async () => {
  fixture = await createAuthFixture();
  token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  stranger = (await issueSessionFor(fixture, fixture.beta, fixture.beta.salesperson)).accessToken;
});
afterAll(async () => { await fixture?.stop(); });
async function request(path: string, authToken: string | null, payload?: Record<string, unknown>) {
  const request: ApiRequest = { method: payload === undefined ? 'GET' : 'POST', path, query: new URLSearchParams(), headers: authToken === null ? {} : { authorization: `Bearer ${authToken}` }, body: payload };
  return await dispatch(request, { auth: fixture.deps, session: fixture.db, supportedClientVersions: fixture.deps.config.supportedClientVersions, suppressionJournal: localNoopSuppressionJournal(), sendingEnabled: false });
}
const command = (payload: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...payload });
function result(body: unknown): unknown { if (typeof body !== 'object' || body === null || !('result' in body)) throw new Error('command result absent'); return body.result; }

it('authenticates a current call notification, deduplicates its device attempt and keeps acknowledgement separate from call completion', async () => {
  const firmId = await seedFirm(fixture, { name: 'Northwind Test Holdings', regionCode: 'RI', assignedUserId: fixture.alpha.salesperson.userId });
  const meetingId = randomUUID();
  await fixture.db.query("INSERT INTO meetings(workspace_id,id,booking_uid,current_booking_uid,firm_id,state,starts_at,ends_at,last_event_at) VALUES($1,$2,'api-notify','api-notify',$3,'booked',now()+interval '10 minutes',now()+interval '40 minutes',now())", [fixture.alpha.workspaceId, meetingId, firmId]);
  expect((await request('/notifications/actions', null)).status).toBe(401);
  const read = await request('/notifications/actions', token);
  expect(read.status).toBe(200);
  const queue = actionableNotificationsResponseSchema.parse(read.body);
  expect(queue.items).toMatchObject([{ actionId: `meeting:${meetingId}`, phase: 'pre_call', receipt: null }]);
  expect(actionableNotificationsResponseSchema.parse((await request('/notifications/actions', stranger)).body).items).toEqual([]);
  const claimBody = command({ eventKey: queue.items[0]!.eventKey });
  const claimed = await request('/notifications/claim', token, claimBody);
  expect(claimed.status).toBe(200);
  const item = claimNotificationResultSchema.parse(result(claimed.body)).item;
  if (item?.receipt == null) throw new Error('claim absent');
  expect(item.receipt).toMatchObject({ status: 'attempting', nativeShownAt: null, acknowledgedAt: null });
  expect((await request('/notifications/claim', token, claimBody)).body).toMatchObject({ replayed: true, result: { item } });
  expect(claimNotificationResultSchema.parse(result((await request('/notifications/claim', token, command({ eventKey: item.eventKey }))).body)).item).toBeNull();
  const shown = command({ attemptId: item.receipt.attemptId, observation: 'native_shown' });
  expect(observeNotificationResultSchema.parse(result((await request('/notifications/observe', stranger, shown)).body)).recorded).toBe(false);
  expect(observeNotificationResultSchema.parse(result((await request('/notifications/observe', token, shown)).body)).recorded).toBe(true);
  expect(acknowledgeNotificationResultSchema.parse(result((await request('/notifications/acknowledge', token, command({ attemptId: item.receipt.attemptId }))).body)).target).toEqual(item.target);
  expect(actionableNotificationsResponseSchema.parse((await request('/notifications/actions', token)).body).items[0]?.receipt?.status).toBe('acknowledged');
  const today = await request('/today/actions', token);
  expect(today.body).toMatchObject({ actions: [{ actionId: item.actionId, target: item.target }] });
  expect((await request('/notifications/claim', token, command({ eventKey: item.eventKey, deviceId: randomUUID() }))).status).toBe(400);
});
