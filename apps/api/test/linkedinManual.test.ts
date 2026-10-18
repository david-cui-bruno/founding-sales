import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { linkedinManualViewSchema, socialWorkspaceSchema } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { seedManualLinkedin } from '../../../packages/domain/test/db/support/linkedinManualFixture.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
let fixture: AuthFixture;
let token: string;
let binding: Awaited<ReturnType<typeof seedManualLinkedin>>;
const command = (input: object) => ({ commandId: randomUUID(), clientVersion: '1.0.51', ...input });
const post = (path: string, body: unknown, bearer = token) => dispatch({ method: 'POST', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${bearer}` }, body }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: { minimum: '1.0.51', ceiling: '1.4.x', incompatible: [] }, sendingEnabled: false });
beforeAll(async () => {
  fixture = await createAuthFixture();
  fixture = { ...fixture, deps: { ...fixture.deps, config: { ...fixture.deps.config, supportedClientVersions: { minimum: '1.0.51', ceiling: '1.4.x', incompatible: [] } } } };
  token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  const firmId = await seedFirm(fixture, { name: 'Manual synthetic firm', assignedUserId: fixture.alpha.salesperson.userId });
  const context = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.salesperson.userId, role: 'salesperson' }), fixture.db);
  binding = await withTransaction(fixture.db, () => seedManualLinkedin(context, firmId));
});
afterAll(async () => fixture.stop());

it('adds manual ledger commands without changing the installed 1.0.51 social response', async () => {
  expect(socialWorkspaceSchema.safeParse((await post('/social', {})).body).success).toBe(true);
  const request = command(binding);
  const first = await post('/crm/linkedin/manual/bind', request);
  expect(first.status).toBe(200);
  expect((await post('/crm/linkedin/manual/bind', request)).body).toMatchObject({ status: 'accepted', replayed: true });
  const read = await post('/crm/linkedin/manual/read', { ledgerId: binding.ledgerId });
  expect(read.status).toBe(200);
  expect(linkedinManualViewSchema.parse(read.body).ledgers[0]).toMatchObject({ id: binding.ledgerId, connectionState: 'unknown', nativeObservation: false, sendingPermission: false });
});

it('replays exact records, rejects reused IDs with different payload and reads corrections after a fresh session', async () => {
  const record = command({ ledgerId: binding.ledgerId, entryId: randomUUID(), expectedRevision: 0, kind: 'reply', connectionState: null, occurredAt: '2026-10-01T13:00:00.000Z', voided: false, correction: null });
  expect((await post('/crm/linkedin/manual/record', record)).status).toBe(200);
  expect((await post('/crm/linkedin/manual/record', record)).body).toMatchObject({ status: 'accepted', replayed: true });
  expect((await post('/crm/linkedin/manual/record', { ...record, kind: 'invite' })).status).toBe(409);
  const corrected = command({ ...record, commandId: randomUUID(), expectedRevision: 1, voided: true, correction: 'void' });
  expect((await post('/crm/linkedin/manual/record', corrected)).status).toBe(200);
  const fresh = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  const view = linkedinManualViewSchema.parse((await post('/crm/linkedin/manual/read', { ledgerId: binding.ledgerId }, fresh)).body);
  expect(view.history).toHaveLength(2);
  expect(view.ledgers[0]!.handoffRequired).toBe(true);
});

it('fails closed for unknown fields, cross-workspace/account reads and unauthenticated callers', async () => {
  expect((await post('/crm/linkedin/manual/read', { nativeObservation: true })).status).toBe(400);
  expect((await post('/crm/linkedin/manual/read', { before: '9999999999999999999' })).status).toBe(400);
  expect((await post('/crm/linkedin/manual/read', { before: 'not-a-cursor' })).status).toBe(400);
  const beta = (await issueSessionFor(fixture, fixture.beta, fixture.beta.salesperson)).accessToken;
  expect((await post('/crm/linkedin/manual/read', { ledgerId: binding.ledgerId }, beta)).status).toBe(404);
  const admin = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  expect((await post('/crm/linkedin/manual/read', { ledgerId: binding.ledgerId }, admin)).status).toBe(404);
  expect((await post('/crm/linkedin/manual/bind', command({ ...binding, ledgerId: randomUUID() }), admin)).status).toBe(409);
  expect((await post('/crm/linkedin/manual/read', {}, 'not-a-session')).status).toBe(401);
});
