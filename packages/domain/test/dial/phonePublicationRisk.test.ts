import { afterEach, describe, expect, it } from 'vitest';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { withTransaction } from '../../db/queryable.ts';
import { readPhoneHandoffResult, reservePhoneHandoff } from '../../dial/phoneHandoff.ts';
import { adviseDial } from '../../dial/advise.ts';
import { lockSendGateForStopFact } from '../../policy/sendGate.ts';
import { openHold } from '../../policy/holds.ts';
import { recordSuppression } from '../../suppression/events.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { deleteCandidate } from '../../sourcing/candidates.ts';
import { finishQualification, requestQualification } from '../../sourcing/qualificationStore.ts';
import { ownerRiskFixture, riskEndpoint, type OwnerRiskFixture } from './phoneOwnerRiskFixtures.ts';
import { admitOffice, connection, waitsOn } from './phoneOfficeRiskFixtures.ts';

let f: OwnerRiskFixture | undefined;
afterEach(async () => { await f?.database.drop(); f = undefined; });
async function fixture(self = false) { f = await ownerRiskFixture(self); if (!self) await f.assess(); return f; }
async function reserved(value: OwnerRiskFixture) {
  const result = await value.reserve(); expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value.attemptId;
}
async function unchangedAttempt(value: OwnerRiskFixture, id: string, before: unknown) {
  expect(await readPhoneHandoffResult(value.context, id, false)).toMatchObject({ actionable: false, telUri: null, validForMilliseconds: 0 });
  expect((await value.database.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0]).toEqual(before);
}
async function alternate(value: OwnerRiskFixture, kind: 'contact' | 'firm' | 'foreign' | 'unrelated', flagged = true) {
  const w = kind === 'foreign' ? value.seeded.beta.workspaceId : value.w;
  const firmId = kind === 'firm' ? (await value.database.session.query<{ id: string }>(
    "INSERT INTO firms(workspace_id,name) VALUES($1,'Other synthetic firm') RETURNING id", [w])).rows[0]!.id
    : kind === 'foreign' ? value.crm.beta.firmId : value.crm.alpha.firmId;
  const contact = (await value.database.session.query<{ id: string }>(
    "INSERT INTO contacts(workspace_id,firm_id,full_name) VALUES($1,$2,'Other synthetic contact') RETURNING id", [w, firmId])).rows[0]!.id;
  return (await value.database.session.query<{ id: string }>(`INSERT INTO phone_routes
    (workspace_id,firm_id,contact_id,e164,source,retrieved_at,known_personal_cell_at)
    VALUES($1,$2,$3,$4,'website',clock_timestamp(),$5) RETURNING id`,
  [w, firmId, contact, kind === 'unrelated' ? '+12125550188' : riskEndpoint, flagged ? new Date() : null])).rows[0]!.id;
}

describe('owner-risk final current policy and exact frozen office proof', () => {
  it.each(['contact', 'firm'] as const)('exact endpoint personal flag on another %s blocks before reservation', async kind => {
    const value = await fixture(); await admitOffice(value); await alternate(value, kind);
    expect((await adviseDial(value.context, value.request()))?.nationalDnc?.status).toBe('unknown');
    expect(await value.reserve()).toMatchObject({ ok: false, reason: 'dnc_coverage_unknown' });
    expect((await value.database.session.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(0);
  });
  it.each(['contact', 'firm'] as const)('new personal flag on another %s after commit withholds without refund', async kind => {
    const value = await fixture(); await admitOffice(value); const route = await alternate(value, kind, false); const id = await reserved(value);
    const before = (await value.database.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0];
    await value.database.session.query('UPDATE phone_routes SET known_personal_cell_at=clock_timestamp() WHERE id=$1', [route]);
    await unchangedAttempt(value, id, before);
  });
  it.each(['foreign', 'unrelated'] as const)('personal %s association cannot poison a different workspace or endpoint', async kind => {
    const value = await fixture(); await admitOffice(value); await alternate(value, kind); const id = await reserved(value);
    expect(await readPhoneHandoffResult(value.context, id, false)).toMatchObject({ actionable: true });
  });
  it('keeps the explicitly approved self-test basis separate from business office restrictions', async () => {
    const value = await fixture(true); await alternate(value, 'contact'); const id = await reserved(value);
    expect(await readPhoneHandoffResult(value.context, id, false)).toMatchObject({ actionable: true, nationalDnc: { basis: 'owner_self_test' } });
  });
  it.each(['before', 'after'] as const)('retained personal source on another firm blocks %s reservation publication', async timing => {
    const value = await fixture(); const admission = await admitOffice(value);
    const otherRoute = await alternate(value, 'firm', false);
    await value.database.session.query(`UPDATE sourcing_admissions SET firm_id=(SELECT firm_id FROM phone_routes WHERE id=$2),route_id=$2
      WHERE workspace_id=$1`, [value.w, otherRoute]);
    const id = timing === 'after' ? await reserved(value) : null;
    const before = id ? (await value.database.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0] : null;
    await value.database.session.query(`UPDATE sourcing_qualification_runs SET observations=jsonb_set(observations,'{0,blocks}',
      (observations->0->'blocks') || '[{"id":"other-personal","text":"Personal: (212) 555-0187"}]'::jsonb) WHERE id=$1`, [admission.runId]);
    expect((await adviseDial(value.context, value.request()))?.nationalDnc?.status).toBe('unknown');
    if (id) await unchangedAttempt(value, id, before);
    else expect(await value.reserve()).toMatchObject({ ok: false, reason: 'dnc_coverage_unknown' });
  });
  it.each(['assessment', 'admission'] as const)('rechecks %s identity, sources and permissions after commit without borrowing another proof', async kind => {
    // A second valid assessment remains available when the frozen admission is invalidated.
    const changes = kind === 'assessment' ? [
      "UPDATE firms SET name='Changed name' WHERE workspace_id=$1",
      'DELETE FROM evidence_items WHERE workspace_id=$1',
      "UPDATE evidence_items SET terms_allow_retention=false,retention_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
    ] : [
      "UPDATE firms SET website='https://changed.example.test' WHERE workspace_id=$1",
      'DELETE FROM sourcing_candidates WHERE workspace_id=$1',
      "UPDATE sourcing_qualification_runs SET observations=jsonb_set(observations,'{0,firstParty}','false') WHERE workspace_id=$1",
    ];
    for (const sql of changes) {
      const value = await fixture(); if (kind === 'admission') await admitOffice(value);
      const id = await reserved(value);
      const before = (await value.database.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0];
      await value.database.session.query(sql, [value.w]); await unchangedAttempt(value, id, before);
      await value.database.drop(); f = undefined;
    }
  });
  it.each(['assessment', 'admission'] as const)('retained contrary exact phone evidence after %s commit withholds', async kind => {
    const value = await fixture(); if (kind === 'admission') await admitOffice(value);
    const id = await reserved(value); const before = (await value.database.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0];
    // A retained unselected source block is restrictive even when its hash makes the positive proof invalid too.
    await value.database.session.query(`UPDATE firm_office_assessment_sources SET observation=jsonb_set(observation,'{blocks}',
      (observation->'blocks') || '[{"id":"personal-new","text":"Mobile: (212) 555-0187"}]'::jsonb) WHERE workspace_id=$1`, [value.w]);
    await unchangedAttempt(value, id, before);
  });
  it('cannot substitute a new valid admission for the frozen assessment when assessment sources disappear', async () => {
    const value = await fixture(); const id = await reserved(value);
    const before = (await value.database.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0];
    await admitOffice(value);
    await value.database.session.query('DELETE FROM evidence_items WHERE workspace_id=$1', [value.w]);
    // Advice can truthfully show the new proof, but it cannot rebind this old attempt.
    expect((await adviseDial(value.context, value.request()))?.nationalDnc?.status).toBe('not_checked_owner_risk');
    await unchangedAttempt(value, id, before);
  });
  it('cannot substitute a new current admission run for the exact frozen admission ID', async () => {
    const value = await fixture(); const old = await admitOffice(value); const id = await reserved(value);
    const before = (await value.database.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0];
    await value.database.session.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1', [old.candidateId]);
    const next = await withTransaction(value.runtime, () => requestQualification(value.context,
      { candidateId: old.candidateId, expectedRevision: 2 }, { enqueue: false }));
    if (!next.ok) throw new Error(next.reason);
    expect((await withTransaction(value.runtime, () => finishQualification(value.context, { runId: next.value.runId,
      observations: [old.source.observation], facts: old.source.facts, reason: null }))).ok).toBe(true);
    await value.database.session.query('UPDATE sourcing_admissions SET run_id=$2 WHERE candidate_id=$1', [old.candidateId, next.value.runId]);
    expect((await adviseDial(value.context, value.request()))?.nationalDnc?.status).toBe('not_checked_owner_risk');
    await unchangedAttempt(value, id, before);
  });
  it.each(['suppression', 'hold'] as const)('stop %s committed while final publication waits on gate withholds consumed self-test', async kind => {
    const value = await fixture(true); const id = await reserved(value);
    const before = (await value.database.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0];
    const stop = await connection(value); const publication = await connection(value);
    const stopContext = repositoryContext(value.context.scope, stop.session);
    await stop.session.query('BEGIN'); await lockSendGateForStopFact(stopContext);
    const pending = readPhoneHandoffResult(repositoryContext(value.context.scope, publication.session), id, false);
    try {
      await waitsOn(value, publication.pid, stop.pid);
      if (kind === 'suppression') await recordSuppression(stopContext, { scope: 'firm', firmId: value.crm.alpha.firmId,
        channel: 'phone', source: 'prospect_do_not_call', journal: recordingSuppressionJournal() });
      else await openHold(stopContext, { scopeKind: 'workspace', reasonCode: 'restore_in_progress',
        blockedActionKinds: ['dial_authorization'], sourceEventKind: 'synthetic_test' });
    } finally { await stop.session.query('COMMIT'); }
    expect(await pending).toMatchObject({ actionable: false, telUri: null });
    await unchangedAttempt(value, id, before); expect((await value.reserve()).ok).toBe(false);
  });
  it.each([
    "UPDATE phone_routes SET eligibility='invalid',version=version+1 WHERE workspace_id=$1",
    "DELETE FROM state_postures WHERE workspace_id=$1",
    "UPDATE firms SET time_zone=NULL,time_zone_confidence=NULL,time_zone_source=NULL,time_zone_rule_version=NULL WHERE workspace_id=$1",
    `INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id)
      SELECT workspace_id,'calling_provider',1,'{"provider":"twilio"}',owner_user_id FROM phone_owner_risk_receipts WHERE workspace_id=$1`,
  ])('current ordinary policy loss after commit refuses without renewing: %s', async sql => {
    const value = await fixture(true); const id = await reserved(value);
    const before = (await value.database.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0];
    await value.database.session.query(sql, [value.w]); await unchangedAttempt(value, id, before);
  });
  it.each(['delete', 'finish'] as const)('candidate-first %s concurrent with reservation has no run/candidate deadlock and fails closed', async kind => {
    const value = await fixture(); const admission = await admitOffice(value);
    await value.database.session.query('DELETE FROM firm_office_assessments WHERE workspace_id=$1', [value.w]);
    const writer = await connection(value); const reader = await connection(value);
    const writerContext = repositoryContext(value.context.scope, writer.session);
    await writer.session.query('BEGIN');
    await writer.session.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [value.w, admission.candidateId]);
    const pending = withTransaction(reader.session, () => reservePhoneHandoff(repositoryContext(value.context.scope, reader.session), value.request()));
    try {
      await waitsOn(value, reader.pid, writer.pid);
      if (kind === 'delete') expect((await deleteCandidate(writerContext, { id: admission.candidateId, expectedRevision: 1 })).ok).toBe(true);
      else {
        expect(await finishQualification(writerContext, { runId: admission.runId, observations: [admission.source.observation],
          facts: admission.source.facts, reason: null })).toMatchObject({ ok: false, reason: 'run_finished' });
        await writer.session.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE workspace_id=$1 AND id=$2', [value.w, admission.candidateId]);
      }
    } finally { await writer.session.query('COMMIT'); }
    expect(await pending).toMatchObject({ ok: false, reason: 'dnc_coverage_unknown' });
    expect((await value.database.session.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(0);
  });
});
