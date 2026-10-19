import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { erasePhoneHandoffs } from '../../retention/phoneHandoffs.ts';
import { previewDeletion, commitDeletion } from '../../retention/deletion.ts';
import { readPhoneHandoffResult } from '../../dial/phoneHandoff.ts';
import { readCallCadence } from '../../calls/cadence.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { createFirm } from '../../crm/firms.ts';
import { mergeFirms } from '../../crm/merges.ts';
import { phoneFixture, type PhoneFixture } from '../dial/phoneHandoffFixtures.ts';
let db: TestDatabase;
let f: PhoneFixture;
beforeAll(async () => { db = await createTestDatabase(); f = await phoneFixture(db); });
afterAll(async () => { await db.drop(); });
beforeEach(async () => { await db.session.query('BEGIN'); await f.publish(); return async () => { await db.session.query('ROLLBACK'); }; });
describe('phone handoff PII erasure and conservative history', () => {
  it('previews and erases bindings and endpoint scrub, keeps opaque count and replay nonactionable', async () => {
    const reserved = await f.reserve();
    if (!reserved.ok) throw new Error(reserved.reason);
    const id = reserved.value.attemptId;
    expect((await logCallOutcome(f.context, { firmId: f.crm.alpha.firmId, phoneHandoffAttemptId: id, outcome: 'no_answer' })).ok).toBe(true);
    const admin = repositoryContext(workspaceScope(f.w, { kind: 'user', userId: f.seeded.alpha.admin.userId, role: 'admin' }), db.session);
    const preview = await previewDeletion(admin, { targetKind: 'firm', firmId: f.crm.alpha.firmId });
    expect(preview.value?.redacts['phone_handoff_attempts']).toBe(1);
    expect(preview.value?.removes['national_registry_endpoint_scrubs']).toBe(1);
    expect(preview.value?.tombstoneHandles).toContain(f.policy.alpha.e164);
    if (!preview.value) throw new Error('no deletion preview');
    const erased = await commitDeletion(admin, { requestId: preview.value.requestId, previewHash: preview.value.previewHash,
      commandId: 'fixture-erase-phone', journal: recordingSuppressionJournal() });
    expect(erased.ok, JSON.stringify(erased)).toBe(true);
    const row = (await db.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0];
    expect(row).toMatchObject({ e164: null, phone_route_id: null, route_version: null, opportunity_id: null, contact_id: null,
      item_id: null, registry_snapshot_id: null, registry_scrubbed_at: null, call_log_id: null });
    expect(row?.['erased_at']).toBeTruthy();
    expect((await db.session.query('SELECT e164 FROM national_registry_endpoint_scrubs')).rows).toHaveLength(0);
    expect(await readPhoneHandoffResult(f.context, id, true)).toMatchObject({ actionable: false, routeId: null, e164: null, telUri: null });
    expect(await readCallCadence(f.context, f.crm.alpha.firmId, f.policy.insideWindow)).toMatchObject({ unansweredAttempts: 1 });
    expect(await logCallOutcome(f.context, { firmId: f.crm.alpha.firmId, phoneHandoffAttemptId: id, outcome: 'no_answer' })).toMatchObject({ ok: false, reason: 'ticket_mismatch' });
  });
  it('moves live context and linked history to the survivor without resetting the attempt count', async () => {
    const reserved = await f.reserve();
    if (!reserved.ok) throw new Error(reserved.reason);
    const logged = await logCallOutcome(f.context, { firmId: f.crm.alpha.firmId, phoneHandoffAttemptId: reserved.value.attemptId, outcome: 'no_answer' });
    if (!logged.ok) throw new Error(logged.reason);
    const admin = repositoryContext(workspaceScope(f.w, { kind: 'user', userId: f.seeded.alpha.admin.userId, role: 'admin' }), db.session);
    const target = await createFirm(admin, { name: 'Fixture merge survivor' });
    if (!target.ok) throw new Error(target.reason);
    const merged = await mergeFirms(admin, { sourceFirmId: f.crm.alpha.firmId, targetFirmId: target.value.id, journal: recordingSuppressionJournal() });
    expect(merged.ok).toBe(true);
    expect((await db.session.query('SELECT firm_id FROM phone_handoff_attempts WHERE id=$1', [reserved.value.attemptId])).rows[0]?.['firm_id']).toBe(target.value.id);
    expect((await db.session.query('SELECT firm_id FROM call_logs WHERE id=$1', [logged.value.callLogId])).rows[0]?.['firm_id']).toBe(target.value.id);
    expect(await readCallCadence(admin, target.value.id, f.policy.insideWindow)).toMatchObject({ unansweredAttempts: 1 });
  });
  it('reconciles only a unique exact duplicate route through a verified merge, never an unrelated chain', async () => {
    await db.session.query('UPDATE phone_routes SET contact_id=NULL WHERE workspace_id=$1 AND id=$2', [f.w, f.policy.alpha.phoneRouteId]);
    const reserved = await f.reserve();
    if (!reserved.ok) throw new Error(reserved.reason);
    const admin = repositoryContext(workspaceScope(f.w, { kind: 'user', userId: f.seeded.alpha.admin.userId, role: 'admin' }), db.session);
    const target = await createFirm(admin, { name: 'Exact duplicate route survivor', assignedUserId: f.seeded.alpha.salesperson.userId });
    const unrelated = await createFirm(admin, { name: 'Unrelated fixture firm' });
    if (!target.ok || !unrelated.ok) throw new Error('fixture firm creation refused');
    const survivingRoute = (await db.session.query<{ id: string }>(`INSERT INTO phone_routes
      (workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version)
      VALUES($1,$2,$3,'research_provider',now(),1,'passed','usable','route-policy.1') RETURNING id`, [f.w, target.value.id, f.policy.alpha.e164])).rows[0];
    if (!survivingRoute) throw new Error('missing survivor route');
    const merged = await mergeFirms(admin, { sourceFirmId: f.crm.alpha.firmId, targetFirmId: target.value.id, journal: recordingSuppressionJournal() });
    expect(merged.ok).toBe(true);
    const input = { firmId: target.value.id, routeId: f.policy.alpha.phoneRouteId, phoneHandoffAttemptId: reserved.value.attemptId, outcome: 'no_answer' as const };
    await db.session.query('SAVEPOINT unrelated_chain');
    await db.session.query('UPDATE firms SET merged_into_firm_id=$3 WHERE workspace_id=$1 AND id=$2', [f.w, f.crm.alpha.firmId, unrelated.value.id]);
    expect(await logCallOutcome(f.context, input)).toMatchObject({ ok: false, reason: 'route_unknown' });
    expect((await db.session.query('SELECT call_log_id FROM phone_handoff_attempts WHERE id=$1', [reserved.value.attemptId])).rows[0]?.['call_log_id']).toBeNull();
    await db.session.query('ROLLBACK TO SAVEPOINT unrelated_chain');
    expect(await logCallOutcome(f.context, { ...input, routeId: survivingRoute.id })).toMatchObject({ ok: false, reason: 'ticket_mismatch' });
    const logged = await logCallOutcome(f.context, input);
    if (!logged.ok) throw new Error(logged.reason);
    expect((await db.session.query('SELECT phone_route_id FROM call_logs WHERE id=$1', [logged.value.callLogId])).rows[0]?.['phone_route_id']).toBe(survivingRoute.id);
    expect((await db.session.query('SELECT phone_route_id,e164 FROM phone_handoff_attempts WHERE id=$1', [reserved.value.attemptId])).rows[0])
      .toMatchObject({ phone_route_id: f.policy.alpha.phoneRouteId, e164: f.policy.alpha.e164 });
    expect(await logCallOutcome(f.context, input)).toMatchObject({ ok: false, reason: 'call_already_logged' });
    expect(await readCallCadence(f.context, target.value.id, f.policy.insideWindow)).toMatchObject({ unansweredAttempts: 1 });
    const preview = await previewDeletion(admin, { targetKind: 'firm', firmId: f.crm.alpha.firmId });
    if (!preview.value) throw new Error('missing merged-source erasure preview');
    expect(preview.value.redacts['phone_handoff_attempts']).toBe(1);
    const erased = await commitDeletion(admin, { requestId: preview.value.requestId, previewHash: preview.value.previewHash,
      commandId: 'erase-merged-source-phone', journal: recordingSuppressionJournal() });
    expect(erased).toMatchObject({ ok: false, reason: 'firm_unknown' });
    // Existing mutation policy excludes merged firms. The internal erasure primitive must
    // still clear its exact frozen-route closure before any authorized route cleanup.
    expect(await erasePhoneHandoffs(admin, { firmId: f.crm.alpha.firmId, contactId: null })).toMatchObject({ attempts: 1 });
    await db.session.query('DELETE FROM phone_routes WHERE workspace_id=$1 AND id=$2', [f.w, f.policy.alpha.phoneRouteId]);
    expect((await db.session.query('SELECT phone_route_id,e164,firm_id FROM phone_handoff_attempts WHERE id=$1', [reserved.value.attemptId])).rows[0])
      .toMatchObject({ phone_route_id: null, e164: null, firm_id: target.value.id });
    expect((await db.session.query('SELECT id FROM phone_routes WHERE id=$1', [f.policy.alpha.phoneRouteId])).rows).toHaveLength(0);
    expect(await readCallCadence(f.context, target.value.id, f.policy.insideWindow)).toMatchObject({ unansweredAttempts: 1 });
  });
});
