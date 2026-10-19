import { afterEach, describe, expect, it } from 'vitest';
import { NATIONAL_DNC_COVERED_AREA_CODES, NATIONAL_DNC_UNCHECKED_WARNING } from '@fss/contracts';
import { reservePhoneHandoff, readPhoneHandoffResult } from '../../dial/phoneHandoff.ts';
import { adviseDial } from '../../dial/advise.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { withTransaction, type QueryResultRowLike } from '../../db/queryable.ts';
import { erasePhoneHandoffs, measurePhoneHandoffDeletion } from '../../retention/phoneHandoffs.ts';
import { lockSendGateForStopFact } from '../../policy/sendGate.ts';
import { recordSuppression } from '../../suppression/events.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { ownerRiskFixture, riskEndpoint, type OwnerRiskFixture } from './phoneOwnerRiskFixtures.ts';
import { publishTestRegistrySnapshot } from '../support/nationalRegistry.ts';
let f: OwnerRiskFixture | undefined;
afterEach(async () => { await f?.database.drop(); f = undefined; });
async function fixture(selfTest = true) { f = await ownerRiskFixture(selfTest); return f; }
async function reserved(value: OwnerRiskFixture) {
  const answer = await value.reserve();
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.reason);
  return answer.value.attemptId;
}
const unknown = { ok: false, reason: 'dnc_coverage_unknown' };
describe('owner accepted uncovered iPhone policy and permanent self-test consumption', () => {
  it('retained exact known match blocks even the privately approved uncovered self-test', async () => {
    const value = await fixture();
    const snapshotId = await publishTestRegistrySnapshot(value.database.session, value.w);
    await value.database.session.query(`INSERT INTO national_registry_endpoint_scrubs(workspace_id,snapshot_id,e164,scrubbed_at,result)
      VALUES($1,$2,$3,clock_timestamp(),'match')`, [value.w, snapshotId, riskEndpoint]);
    expect(await value.reserve()).toEqual({ ok: false, reason: 'dnc_registry_match' });
  });
  it('publication at or beyond original risk expiry withholds URI without renewing or refunding', async () => {
    const value = await fixture(); const id = await reserved(value);
    const future = new Date(Date.now() + 60_000);
    const delayed = repositoryContext(value.context.scope, { query: async <Row extends QueryResultRowLike>(text: string, values?: readonly unknown[]) => value.runtime.query<Row>(
      text === 'SELECT clock_timestamp() AS at' ? 'SELECT $1::timestamptz AS at' : text,
      text === 'SELECT clock_timestamp() AS at' ? [future] : values) });
    expect(await readPhoneHandoffResult(delayed, id, false)).toMatchObject({ actionable: false, telUri: null });
    expect(await value.reserve()).toEqual(unknown);
  });
  it('discloses the same receipt before click and durably consumes the separate self-test without fake registry or office proof', async () => {
    const value = await fixture();
    expect(await adviseDial(value.context, value.request())).toMatchObject({ nationalDnc: {
      status: 'not_checked_owner_risk', basis: 'owner_self_test', receiptId: value.receiptId, warning: NATIONAL_DNC_UNCHECKED_WARNING } });
    const id = await reserved(value);
    expect((await value.database.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0]).toMatchObject({
      national_dnc_basis: 'owner_self_test', owner_risk_receipt_id: value.receiptId, registry_snapshot_id: null,
      registry_scrubbed_at: null, office_proof_id: null });
    expect(await readPhoneHandoffResult(value.context, id, false)).toMatchObject({ actionable: true, e164: riskEndpoint,
      nationalDnc: { receiptId: value.receiptId, status: 'not_checked_owner_risk' }, validForMilliseconds: 15000 });
    expect(await readPhoneHandoffResult(value.context, id, true)).toMatchObject({ actionable: false, telUri: null });
    expect(await value.reserve()).toEqual(unknown);
  });
  it.each([{ clientVersion: '1.0.55' }, { expectedNationalDncReceiptId: '' }, { expectedNationalDncReceiptId: '00000000-0000-4000-8000-000000000123' }])(
    'refuses undisclosed/old-client risk before an attempt %j', async override => {
      const value = await fixture(); expect(await value.reserve(override)).toEqual(unknown);
      expect((await value.database.session.query('SELECT id FROM phone_handoff_attempts')).rows).toEqual([]);
    });
  it('refuses missing and null receipt echo, not just a different receipt', async () => {
    const value = await fixture();
    const { expectedNationalDncReceiptId: _omitted, ...request } = value.request();
    for (const echo of [{}, { expectedNationalDncReceiptId: null }]) {
      expect(await withTransaction(value.runtime, () => reservePhoneHandoff(value.context, { ...request, ...echo }))).toEqual(unknown);
    }
  });
  it.each(NATIONAL_DNC_COVERED_AREA_CODES)('never converts covered code %s to uncovered on unknown coverage', async code => {
    const value = await fixture();
    await value.database.session.query('UPDATE phone_routes SET e164=$2 WHERE id=$1', [value.policy.alpha.phoneRouteId, `+1${code}5550187`]);
    expect(await value.reserve()).toEqual(unknown);
  });
  it('does not use accepted risk for unproved business offices or an endpoint rebind', async () => {
    const value = await fixture(false);
    expect(await value.reserve()).toEqual(unknown);
    expect((await adviseDial(value.context, value.request()))?.nationalDnc?.status).toBe('unknown');
  });
  it.each([
    "UPDATE phone_owner_risk_receipts SET revoked_at=clock_timestamp(),revocation_reference='fixture-revoke' WHERE workspace_id=$1",
    "UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",
    "UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",
    "UPDATE devices SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",
  ])('rechecks current authority before reservation: %s', async sql => {
    const value = await fixture(); await value.database.session.query(sql, [value.w, value.owner.userId].slice(0, sql.includes('$2') ? 2 : 1));
    expect((await value.reserve()).ok).toBe(false);
    expect((await value.database.session.query('SELECT id FROM phone_handoff_attempts')).rows).toEqual([]);
  });
  it('internal DNC still blocks even this exact approved self-test', async () => {
    const value = await fixture();
    await recordSuppression(value.context, { scope: 'firm', firmId: value.crm.alpha.firmId, channel: 'phone', source: 'prospect_do_not_call', journal: recordingSuppressionJournal() });
    expect(await value.reserve()).toEqual({ ok: false, reason: 'firm_suppressed' });
  });
  it.each([
    "UPDATE phone_owner_risk_receipts SET revoked_at=clock_timestamp(),revocation_reference='fixture-revoke' WHERE workspace_id=$1",
    "UPDATE devices SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",
    "UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",
    "UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",
    "UPDATE phone_routes SET version=version+1 WHERE workspace_id=$1",
    "UPDATE firms SET assigned_user_id=NULL WHERE workspace_id=$1",
  ])('risk-only publication rejects changed current authority without refund: %s', async sql => {
    const value = await fixture(); const id = await reserved(value);
    await value.database.session.query(sql, [value.w, value.owner.userId].slice(0, sql.includes('$2') ? 2 : 1));
    expect(await readPhoneHandoffResult(value.context, id, false)).toMatchObject({ actionable: false, telUri: null });
    expect((await value.database.session.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(1);
  });
  it('serializes distinct runtime commands and keeps single-use consumed through erasure', async () => {
    const value = await fixture();
    const second = await value.database.appRuntimeSession();
    const other = repositoryContext(value.context.scope, second);
    const results = await Promise.all([value.reserve(), withTransaction(second, () => reservePhoneHandoff(other, value.request()))]);
    expect(results.filter(answer => answer.ok)).toHaveLength(1);
    const answer = results.find(result => result.ok); if (!answer?.ok) throw new Error('missing attempt');
    await withTransaction(value.runtime, async () => {
      await lockSendGateForStopFact(value.context);
      expect(await erasePhoneHandoffs(value.context, { firmId: value.crm.alpha.firmId, contactId: null })).toMatchObject({ attempts: 1, receipts: 1 });
    });
    expect((await value.database.session.query('SELECT * FROM phone_owner_risk_receipts')).rows[0]).toMatchObject({ self_test_firm_id: null, self_test_e164: null });
    expect((await value.database.session.query('SELECT * FROM phone_handoff_attempts')).rows[0]).toMatchObject({ national_dnc_basis: 'owner_self_test', owner_risk_receipt_id: value.receiptId, e164: null });
    expect(await readPhoneHandoffResult(value.context, answer.value.attemptId, false)).toMatchObject({ actionable: false, telUri: null });
    expect(await value.reserve()).toEqual(unknown);
  });
  it('erases privately bound receipt endpoint even before the one test has been attempted', async () => {
    const value = await fixture();
    const scope = { firmId: value.crm.alpha.firmId, contactId: null };
    expect(await measurePhoneHandoffDeletion(value.context, scope)).toMatchObject({ attempts: 0, receipts: 1, handles: [riskEndpoint] });
    await withTransaction(value.runtime, async () => { await lockSendGateForStopFact(value.context); await erasePhoneHandoffs(value.context, scope); });
    expect((await value.database.session.query('SELECT self_test_e164,self_test_firm_id,self_test_erased_at FROM phone_owner_risk_receipts')).rows[0]).toMatchObject({ self_test_e164: null, self_test_firm_id: null });
  });
  it('cannot borrow the owner receipt using stale actor scope, another device or workspace', async () => {
    const value = await fixture();
    expect((await value.reserve({ deviceId: value.seeded.beta.admin.deviceId })).ok).toBe(false);
    const foreign = repositoryContext(workspaceScope(value.seeded.beta.workspaceId, value.context.scope.actor), value.runtime);
    expect((await withTransaction(value.runtime, () => reservePhoneHandoff(foreign, value.request()))).ok).toBe(false);
  });
});
