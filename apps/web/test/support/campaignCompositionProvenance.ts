import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EmailCampaignAdmission } from '@fss/contracts';
import type { ThinHostApp } from './thinHostApp.ts';
/** Actual migrated lineage, not a supplied publication authority. */
export async function checkCompositionProvenance(app: ThinHostApp, admission: EmailCampaignAdmission) {
  const db = app.fixture.db;
  const publication = (await db.query('SELECT * FROM sourcing_automatic_research_firms WHERE candidate_id=$1', [admission.candidateId])).rows[0]!;
  const history = (await db.query('SELECT * FROM outreach_email_campaign_admissions WHERE candidate_id=$1', [admission.candidateId])).rows[0]!;
  assert.equal(history['source_kind'], 'automatic_research');
  for (const [historyKey, publicationKey] of [['publication_id', 'id'], ['publication_revision', 'revision'], ['candidate_revision', 'candidate_revision'], ['evidence_fingerprint', 'evidence_fingerprint']]) assert.equal(history[historyKey!], publication[publicationKey!]);
  assert.equal(history['firm_id'], publication['firm_id']);
  assert.equal(history['qualification_run_id'], publication['run_id']);
  assert(!JSON.stringify(history).includes('@'));
  assert(!JSON.stringify(history).includes('https://'));
  await db.query('BEGIN');
  try {
    await db.query('SAVEPOINT immutable');
    await assert.rejects(db.query('UPDATE outreach_email_campaign_admissions SET evidence_fingerprint=$2 WHERE candidate_id=$1', [admission.candidateId, 'b'.repeat(64)]), { code: '23514', constraint: 'email_campaign_source_immutable' });
    await db.query('ROLLBACK TO SAVEPOINT immutable');
    await db.query('DELETE FROM outreach_email_campaign_admissions WHERE candidate_id=$1', [admission.candidateId]);
    const changed = { ...history, publication_id: randomUUID() };
    await assert.rejects(db.query(`INSERT INTO outreach_email_campaign_admissions(${Object.keys(changed).join(',')}) VALUES(${Object.keys(changed).map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(changed)), { code: '23514', constraint: 'email_campaign_automatic_lineage' });
  } finally { await db.query('ROLLBACK'); }
}
