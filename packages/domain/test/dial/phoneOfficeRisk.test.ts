import { afterEach, describe, expect, it } from 'vitest';
import { readPhoneOfficeProof } from '../../dial/phoneOfficeProof.ts';
import { readPhoneHandoffResult } from '../../dial/phoneHandoff.ts';
import { adviseDial } from '../../dial/advise.ts';
import { ownerRiskFixture, riskEndpoint, type OwnerRiskFixture } from './phoneOwnerRiskFixtures.ts';
import { officeHtml } from '../support/officeProviders.ts';
import type { SourceObservation, QualificationFact } from '@fss/contracts';
import { saveCandidate } from '../../sourcing/candidates.ts';
import { requestQualification, finishQualification } from '../../sourcing/qualificationStore.ts';
import { withTransaction } from '../../db/queryable.ts';
let f: OwnerRiskFixture | undefined;
afterEach(async () => { await f?.database.drop(); f = undefined; });
async function fixture(html?: string) { f = await ownerRiskFixture(false); await f.assess(html); return f; }
async function proof(value: OwnerRiskFixture) { return await readPhoneOfficeProof(value.context, { ...value.request(), e164: riskEndpoint, at: new Date().toISOString() }); }
describe('source-bound strict business-office owner risk', () => {
  it('reconstructs admission-owned source proof, not a weak historical phone label, and rechecks revision', async () => {
    const value = await fixture();
    const source = (await value.database.session.query<{ observation: SourceObservation; facts: QualificationFact[] }>(
      'SELECT observation,facts FROM firm_office_assessment_sources WHERE workspace_id=$1', [value.w])).rows[0]!;
    const candidate = await withTransaction(value.runtime, () => saveCandidate(value.context, { firmName: 'Northwind Test Holdings',
      website: 'https://northwind.example.test', locality: 'Providence', region: 'RI', signal: 'fit_only', evidence: 'Synthetic source',
      sourceUrl: 'https://northwind.example.test', observedOn: new Date().toISOString().slice(0, 10), preparedBy: 'Synthetic test only' }));
    if (!candidate.ok) throw new Error(candidate.reason);
    const run = await withTransaction(value.runtime, () => requestQualification(value.context, { candidateId: candidate.value.id, expectedRevision: 1 }, { enqueue: false }));
    if (!run.ok) throw new Error(run.reason);
    expect((await withTransaction(value.runtime, () => finishQualification(value.context, { runId: run.value.runId,
      observations: [source.observation], facts: source.facts, reason: null }))).ok).toBe(true);
    // The association is a constrained fixture, not a substitute for the verifier's proof.
    await value.database.session.query(`INSERT INTO sourcing_admissions(workspace_id,candidate_id,run_id,firm_id,route_id)
      VALUES($1,$2,$3,$4,$5)`, [value.w, candidate.value.id, run.value.runId, value.crm.alpha.firmId, value.policy.alpha.phoneRouteId]);
    await value.database.session.query('DELETE FROM firm_office_assessments WHERE workspace_id=$1', [value.w]);
    expect(await proof(value)).toMatchObject({ kind: 'admission', id: run.value.runId });
    await value.database.session.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1', [candidate.value.id]);
    expect(await proof(value)).toBeNull(); expect((await value.reserve()).ok).toBe(false);
  });
  it('reconstructs a current schema122 proof, warns before click and freezes genuine proof without registry snapshot', async () => {
    const value = await fixture();
    expect(await proof(value)).toMatchObject({ kind: 'office_assessment' });
    expect((await adviseDial(value.context, value.request()))?.nationalDnc).toMatchObject({ status: 'not_checked_owner_risk', basis: 'verified_business_office', receiptId: value.receiptId });
    const answer = await value.reserve(); expect(answer.ok, JSON.stringify(answer)).toBe(true);
    if (!answer.ok) throw new Error(answer.reason);
    expect((await value.database.session.query('SELECT * FROM phone_handoff_attempts')).rows[0]).toMatchObject({
      national_dnc_basis: 'office_owner_risk', office_proof_kind: 'office_assessment', registry_snapshot_id: null, owner_risk_receipt_id: value.receiptId });
    expect(await readPhoneHandoffResult(value.context, answer.value.attemptId, false)).toMatchObject({ actionable: true,
      nationalDnc: { basis: 'verified_business_office', receiptId: value.receiptId } });
  });
  it.each(['personal', 'cell', 'mobile'])('a retained unselected exact-phone %s association overrides positive office facts', async label => {
    const html = officeHtml.replace('(401)', '(212)').replace('</main>', `<aside><p>${label}: (212) 555-0187</p></aside></main>`);
    const value = await fixture(html);
    expect(await proof(value)).toBeNull(); expect(await value.reserve()).toMatchObject({ ok: false, reason: 'dnc_coverage_unknown' });
  });
  it('a known-personal restrictive fact overrides all otherwise positive proof', async () => {
    const value = await fixture();
    await value.database.session.query('UPDATE phone_routes SET known_personal_cell_at=clock_timestamp() WHERE id=$1', [value.policy.alpha.phoneRouteId]);
    expect(await proof(value)).toBeNull(); expect((await value.reserve()).ok).toBe(false);
  });
  it.each([
    "UPDATE firms SET name='Changed Identity' WHERE workspace_id=$1",
    "UPDATE phone_routes SET version=version+1 WHERE workspace_id=$1",
    "UPDATE evidence_items SET retention_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
    "DELETE FROM evidence_items WHERE workspace_id=$1",
    "UPDATE firm_office_assessments SET captured_at=captured_at-interval '8 days',assessed_at=assessed_at-interval '8 days',expires_at=expires_at-interval '8 days' WHERE workspace_id=$1",
    "UPDATE firm_office_assessments SET assessment_version='other-policy' WHERE workspace_id=$1",
    "UPDATE firm_office_assessment_sources SET facts=jsonb_set(facts,'{0,value}','\"invented office proof\"') WHERE workspace_id=$1",
  ])('fails closed on stale, lost, changed or invented proof: %s', async sql => {
    const value = await fixture(); await value.database.session.query(sql, [value.w]);
    expect(await proof(value)).toBeNull(); expect((await value.reserve()).ok).toBe(false);
  });
  it('does not let the internal self record masquerade as a business office on another number', async () => {
    f = await ownerRiskFixture(true); const value = f;
    await value.database.session.query('UPDATE phone_routes SET e164=$2 WHERE id=$1', [value.policy.alpha.phoneRouteId, '+12125550188']);
    expect((await value.reserve()).ok).toBe(false);
  });
});
