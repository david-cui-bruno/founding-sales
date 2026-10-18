import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { LinkedinManualRecord } from '../../../contracts/src/linkedinManual.ts';
import { bindLinkedinManual, recordLinkedinManual } from '../../crm/linkedinManual.ts';
import { readLinkedinManual } from '../../crm/linkedinManualRead.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { listApplicableHolds } from '../../policy/holds.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedManualLinkedin } from '../db/support/linkedinManualFixture.ts';
import { seedSequences, type SeededSequences } from '../sequences/support/sequenceFixtures.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { readPerson, changeSelectedSource } from '../../crm/people.ts';
import { saveRelationship } from '../../crm/relationships.ts';
import { registerSocialManualDestination } from '../../social/manualDestination.ts';
import { correctEndpoint } from '../../crm/endpoints.ts';
let db: TestDatabase;
let members: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;
const owner = () => repositoryContext(workspaceScope(members.alpha.workspaceId, { kind: 'user', userId: members.alpha.salesperson.userId, role: 'salesperson' }), db.session);
const tx = <T>(work: () => Promise<T>) => withTransaction(db.session, work);
const activity = (ledgerId: string, patch: Partial<LinkedinManualRecord> = {}): LinkedinManualRecord => ({ ledgerId, entryId: randomUUID(), expectedRevision: 0, kind: 'invite', connectionState: null, occurredAt: '2026-10-01T13:00:00.000Z', voided: false, correction: null, ...patch });
async function setup() {
  const binding = await tx(() => seedManualLinkedin(owner(), crm.alpha.firmId));
  expect(await tx(() => bindLinkedinManual(owner(), binding))).toMatchObject({ ok: true });
  return binding;
}
beforeAll(async () => { db = await createTestDatabase(); members = await seedTwoWorkspaces(db.session); crm = await seedCrm(db.session, members); sequences = await seedSequences(db.session, members); });
afterAll(async () => db.drop());

it('starts unknown, keeps invitations distinct from acceptance and preserves dated history after new repository context', async () => {
  const binding = await setup();
  const entry = activity(binding.ledgerId);
  expect(await tx(() => recordLinkedinManual(owner(), entry))).toMatchObject({ ok: true, value: { revision: 1 } });
  const view = await tx(() => readLinkedinManual(owner(), { ledgerId: binding.ledgerId }));
  expect(view!.ledgers.find(row => row.id === binding.ledgerId)).toMatchObject({ connectionState: 'unknown', sendingPermission: false, nativeObservation: false });
  expect(view!.history).toHaveLength(1);
  expect(view!.history[0]).toMatchObject({ kind: 'invite', channel: 'linkedin', ownerAssertion: true, occurredAt: entry.occurredAt });
  const runtime = await db.appRuntimeSession();
  expect(await withTransaction(runtime, () => recordLinkedinManual(repositoryContext(owner().scope, runtime), activity(binding.ledgerId, { kind: 'message' })))).toMatchObject({ ok: true });
});

it('is idempotent across new commands and refuses changed payloads or stale corrections without losing originals', async () => {
  const binding = await setup();
  const entry = activity(binding.ledgerId, { kind: 'connection', connectionState: 'pending' });
  const first = await tx(() => recordLinkedinManual(owner(), entry));
  expect(await tx(() => recordLinkedinManual(owner(), entry))).toEqual(first);
  expect(await tx(() => recordLinkedinManual(owner(), { ...entry, connectionState: 'accepted' }))).toMatchObject({ ok: false, reason: 'entry_conflict' });
  const corrected = { ...entry, expectedRevision: 1, connectionState: 'accepted' as const, correction: 'connection_state' as const };
  expect(await tx(() => recordLinkedinManual(owner(), corrected))).toMatchObject({ ok: true, value: { revision: 2 } });
  expect(await tx(() => recordLinkedinManual(owner(), { ...corrected, connectionState: 'unknown' }))).toMatchObject({ ok: false, reason: 'entry_conflict' });
  const view = await tx(() => readLinkedinManual(owner(), { ledgerId: binding.ledgerId }));
  expect(view!.history).toHaveLength(2);
  expect(view!.ledgers.find(row => row.id === binding.ledgerId)!.connectionState).toBe('accepted');
  expect(await tx(() => recordLinkedinManual(owner(), entry))).toEqual(first);
  expect(await tx(() => recordLinkedinManual(owner(), corrected))).toMatchObject({ ok: true, value: { revision: 2 } });
});

it('orders state by occurrence time rather than late entry, corrections or invitation inference', async () => {
  const binding = await setup();
  await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId, { kind: 'connection', connectionState: 'accepted', occurredAt: '2026-10-03T13:00:00.000Z' })));
  await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId, { kind: 'connection', connectionState: 'pending' })));
  await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId, { kind: 'message' })));
  const view = await tx(() => readLinkedinManual(owner(), { ledgerId: binding.ledgerId }));
  expect(view!.ledgers.find(row => row.id === binding.ledgerId)!.connectionState).toBe('accepted');
});

it.each(['reply', 'refusal'] as const)('latches %s across email, calls and LinkedIn, including corrections and duplicate attempts', async kind => {
  const binding = await setup();
  const enrollment = kind === 'reply' ? await tx(() => enrollContact(owner(), { sequenceVersionId: sequences.alpha.publishedVersionId, originKind: 'prospecting', opportunityId: crm.alpha.opportunityId, firmId: binding.firmId, contactId: crm.alpha.contactId })) : null;
  if (enrollment) expect(enrollment).toMatchObject({ ok: true });
  const entry = activity(binding.ledgerId, { kind });
  expect(await tx(() => recordLinkedinManual(owner(), entry))).toMatchObject({ ok: true });
  if (enrollment?.ok) {
    expect((await db.session.query('SELECT state,end_reason FROM sequence_enrollments WHERE id=$1', [enrollment.value.enrollmentId])).rows[0]).toEqual({ state: 'stopped', end_reason: 'human_reply' });
    expect((await db.session.query('SELECT state,cancel_reason FROM step_executions WHERE enrollment_id=$1', [enrollment.value.enrollmentId])).rows).toEqual([{ state: 'cancelled', cancel_reason: 'terminal_stop' }]);
  }
  for (const actionKind of ['email_send', 'dial_authorization', 'enrollment_advance'] as const) {
    expect((await listApplicableHolds(owner(), { actionKind, firmId: binding.firmId })).some(hold => hold.sourceEventKind === 'linkedin.manual_stop')).toBe(true);
  }
  const holds = (await db.session.query('SELECT hold_id FROM linkedin_manual_stops WHERE workspace_id=$1 AND person_id=$2', [members.alpha.workspaceId, binding.personId])).rows.length;
  expect(await tx(() => recordLinkedinManual(owner(), entry))).toMatchObject({ ok: true });
  expect(await tx(() => recordLinkedinManual(owner(), { ...entry, expectedRevision: 1, voided: true, correction: 'void' }))).toMatchObject({ ok: true });
  const view = await tx(() => readLinkedinManual(owner(), { ledgerId: binding.ledgerId }));
  expect(view!.ledgers.find(row => row.id === binding.ledgerId)!.handoffRequired).toBe(true);
  expect((await db.session.query('SELECT hold_id FROM linkedin_manual_stops WHERE workspace_id=$1 AND person_id=$2', [members.alpha.workspaceId, binding.personId])).rows).toHaveLength(holds);
});

it('pages all retained history through a fresh runtime DB session without losing other ledger choices', async () => {
  const binding = await setup();
  for (let i = 0; i < 53; i++) expect(await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId)))).toMatchObject({ ok: true });
  const runtime = await db.appRuntimeSession();
  const reopened = repositoryContext(owner().scope, runtime);
  const first = (await withTransaction(runtime, () => readLinkedinManual(reopened, { ledgerId: binding.ledgerId })))!;
  const second = (await withTransaction(runtime, () => readLinkedinManual(reopened, { ledgerId: binding.ledgerId, before: first.nextBefore! })))!;
  expect(first.history).toHaveLength(50);
  expect(second.history).toHaveLength(3);
  expect(second.nextBefore).toBeNull();
  expect(new Set([...first.history, ...second.history].map(row => row.sequence)).size).toBe(53);
  expect(first.ledgers.length).toBeGreaterThan(1);
  expect(first.ledgers.map(row => row.id)).toEqual(second.ledgers.map(row => row.id));
});

it('keeps content-free history after source erasure, with no stale profile or current-evidence claim', async () => {
  const binding = await setup();
  await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId)));
  const source = (await tx(() => readPerson(owner(), binding.personId)))!.sources[0]!;
  expect(await tx(() => changeSelectedSource(owner(), { personId: binding.personId, sourceId: source.sourceId, expectedRevision: source.revision }, 'delete'))).toMatchObject({ ok: true });
  const view = (await tx(() => readLinkedinManual(owner(), { ledgerId: binding.ledgerId })))!;
  expect(view.history).toHaveLength(1);
  expect(view.ledgers.find(row => row.id === binding.ledgerId)).toMatchObject({ bindingCurrent: false, profile: null, personName: null, firmName: null, sendingPermission: false });
  expect(view.choices.some(row => row.personId === binding.personId)).toBe(false);
});

it('cannot bypass a person stop with another account or a newly selected Firm relationship', async () => {
  const binding = await setup();
  await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId, { kind: 'refusal' })));
  const secondFirm = randomUUID(), accountId = randomUUID();
  await db.session.query('INSERT INTO firms(workspace_id,id,name,assigned_user_id) VALUES($1,$2,$3,$4)', [members.alpha.workspaceId, secondFirm, 'Second synthetic firm', members.alpha.salesperson.userId]);
  const source = (await tx(() => readPerson(owner(), binding.personId)))!.sources[0]!;
  const relationship = await tx(() => saveRelationship(owner(), { commandId: randomUUID(), clientVersion: '1.0.51', personId: binding.personId, firmId: secondFirm, status: 'current', startDate: null, endDate: null, evidence: { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash! } }));
  if (!relationship.ok || !relationship.value.relationshipId) throw new Error('second synthetic relationship');
  expect(await tx(() => registerSocialManualDestination(owner(), { accountId, platform: 'linkedin', accountKind: 'profile', externalId: `synthetic-${accountId}`, displayName: 'Other owner manual account' }))).toMatchObject({ ok: true });
  const second = { ...binding, ledgerId: randomUUID(), firmId: secondFirm, accountId, relationshipId: relationship.value.relationshipId };
  expect(await tx(() => bindLinkedinManual(owner(), second))).toMatchObject({ ok: true });
  expect(await tx(() => bindLinkedinManual(owner(), { ...second, ledgerId: randomUUID() }))).toMatchObject({ ok: false, reason: 'binding_already_recorded' });
  const view = (await tx(() => readLinkedinManual(owner(), { ledgerId: second.ledgerId })))!;
  expect(view.ledgers.find(row => row.id === second.ledgerId)).toMatchObject({ handoffRequired: true, connectionState: 'unknown', sendingPermission: false });
  expect((await listApplicableHolds(owner(), { actionKind: 'email_send', firmId: secondFirm })).some(hold => hold.sourceEventKind === 'linkedin.manual_stop')).toBe(true);
  const profile = view.choices.find(row => row.claimId === binding.claimId)!.profile;
  expect(await tx(() => correctEndpoint(owner(), { commandId: randomUUID(), clientVersion: '1.0.51', claimId: binding.claimId, expectedRevision: 1, personId: binding.personId, firmId: null, kind: 'linkedin', value: profile, shared: false, status: 'current', startDate: null, endDate: null, evidence: { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash! } }))).toMatchObject({ ok: true });
  const revised = { ...binding, ledgerId: randomUUID(), claimRevision: 2 };
  expect(await tx(() => bindLinkedinManual(owner(), revised))).toMatchObject({ ok: true });
  const revisedView = (await tx(() => readLinkedinManual(owner(), { ledgerId: binding.ledgerId })))!;
  expect(revisedView.ledgers.find(row => row.id === revised.ledgerId)).toMatchObject({ bindingCurrent: true, connectionState: 'unknown', handoffRequired: true, sendingPermission: false });
  expect(revisedView.ledgers.find(row => row.id === binding.ledgerId)).toMatchObject({ bindingCurrent: false, profile: null });
  expect(revisedView.history).toHaveLength(1);
});

it('refuses cross-workspace/account ownership, wrong person/firm identity and future dates', async () => {
  const binding = await setup();
  const beta = repositoryContext(workspaceScope(members.beta.workspaceId, { kind: 'user', userId: members.beta.salesperson.userId, role: 'salesperson' }), db.session);
  expect(await tx(() => recordLinkedinManual(beta, activity(binding.ledgerId)))).toMatchObject({ ok: false });
  expect(await tx(() => bindLinkedinManual(owner(), { ...binding, ledgerId: randomUUID(), personId: randomUUID() }))).toMatchObject({ ok: false });
  expect(await tx(() => bindLinkedinManual(owner(), { ...binding, ledgerId: randomUUID(), firmId: crm.beta.firmId }))).toMatchObject({ ok: false });
  expect(await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId, { occurredAt: '2099-01-01T00:00:00.000Z' })))).toMatchObject({ ok: false, reason: 'future_activity' });
  expect((await tx(() => readLinkedinManual(beta, {})))!.ledgers).toEqual([]);
});

it('rechecks current ownership on read and preserves immutable audit rows in app_runtime', async () => {
  const binding = await setup();
  await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId)));
  await db.session.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2', [members.alpha.workspaceId, binding.firmId, members.alpha.admin.userId]);
  expect(await tx(() => readLinkedinManual(owner(), { ledgerId: binding.ledgerId }))).toBeNull();
  expect(await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId)))).toMatchObject({ ok: false });
  await db.session.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2', [members.alpha.workspaceId, binding.firmId, members.alpha.salesperson.userId]);
  const runtime = await db.appRuntimeSession();
  await expect(runtime.query('DELETE FROM linkedin_manual_entries')).rejects.toThrow(/permission denied/u);
});

it('audits exceptional admin profile projections and refuses account transfer or membership revocation', async () => {
  const binding = await setup();
  const admin = repositoryContext(workspaceScope(members.alpha.workspaceId, { kind: 'user', userId: members.alpha.admin.userId, role: 'admin' }), db.session);
  expect((await tx(() => readLinkedinManual(admin, {})))!.choices.some(row => row.personId === binding.personId)).toBe(true);
  const audits = (await db.session.query<{ detail: object }>("SELECT detail FROM audit_events WHERE workspace_id=$1 AND actor_user_id=$2 AND action='linkedin.manual_private_evidence_read'", [members.alpha.workspaceId, members.alpha.admin.userId])).rows;
  expect(audits.length).toBeGreaterThan(0);
  expect(JSON.stringify(audits)).not.toMatch(/Sam Example|linkedin\.com|Owner selected/u);
  await db.session.query('UPDATE social_accounts SET owner_user_id=$3 WHERE workspace_id=$1 AND id=$2', [members.alpha.workspaceId, binding.accountId, members.alpha.admin.userId]);
  expect(await tx(() => readLinkedinManual(owner(), { ledgerId: binding.ledgerId }))).toBeNull();
  expect(await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId)))).toMatchObject({ ok: false });
  await db.session.query('UPDATE social_accounts SET owner_user_id=$3 WHERE workspace_id=$1 AND id=$2', [members.alpha.workspaceId, binding.accountId, members.alpha.salesperson.userId]);
  await db.session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2", [members.alpha.workspaceId, members.alpha.salesperson.userId]);
  expect(await tx(() => readLinkedinManual(owner(), {}))).toBeNull();
  expect(await tx(() => recordLinkedinManual(owner(), activity(binding.ledgerId)))).toMatchObject({ ok: false });
  await db.session.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2", [members.alpha.workspaceId, members.alpha.salesperson.userId]);
});
