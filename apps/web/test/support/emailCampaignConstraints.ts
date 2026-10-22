import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EmailCampaignAdmission } from '@fss/contracts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { ThinHostApp } from './thinHostApp.ts';

async function refuses(db: SessionQueryable, sql: string, values: readonly unknown[], code: string, constraint?: string) {
  await db.query('SAVEPOINT campaign_constraint');
  try {
    let caught: unknown;
    try { await db.query(sql, values); } catch (error) { caught = error; }
    assert(caught, 'Database must refuse the invalid campaign mutation');
    assert.equal((caught as { code: string }).code, code);
    if (constraint) assert.equal((caught as { constraint: string }).constraint, constraint);
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT campaign_constraint');
    await db.query('RELEASE SAVEPOINT campaign_constraint');
  }
}

/** Test the actual migrated constraints and app_runtime privileges, never a copied schema. */
export async function checkCampaignConstraints(app: ThinHostApp, admission: EmailCampaignAdmission) {
  const f = app.fixture;
  const w = f.alpha.workspaceId;
  await f.db.query('BEGIN');
  try {
    await refuses(f.db, 'UPDATE outreach_email_campaigns SET max_enrollments=24 WHERE workspace_id=$1 AND id=$2', [w, admission.campaignId], '23514', 'email_campaign_immutable');
    await refuses(f.db, 'UPDATE outreach_email_sources SET reviewed=true WHERE workspace_id=$1 AND candidate_id=$2', [w, admission.candidateId], '23514', 'outreach_email_sources_campaign_not_reviewed');
    await refuses(f.db, `INSERT INTO outreach_email_campaigns(workspace_id,id,owner_user_id,mailbox_id,sequence_version_id,authorization_revision,regions,max_enrollments,daily_admission_limit,expires_at)
      SELECT $3,$4,$5,mailbox_id,sequence_version_id,authorization_revision,regions,max_enrollments,daily_admission_limit,expires_at FROM outreach_email_campaigns WHERE workspace_id=$1 AND id=$2`,
    [w, admission.campaignId, f.beta.workspaceId, randomUUID(), f.beta.admin.userId], '23503');
    await refuses(f.db, `INSERT INTO outreach_email_campaign_admissions SELECT * FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND campaign_id=$2`, [w, admission.campaignId], '23505');
    // Remove only inside this rolled-back transaction so uniqueness does not mask
    // the workspace-composite Contact -> Firm foreign key under test.
    await f.db.query('SAVEPOINT lineage');
    await f.db.query('DELETE FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND campaign_id=$2', [w, admission.campaignId]);
    await refuses(f.db, `INSERT INTO outreach_email_campaign_admissions(workspace_id,campaign_id,firm_id,contact_id,route_id,plan_id,enrollment_id,candidate_id,qualification_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [w, admission.campaignId, app.alphaFirmId, admission.contactId, admission.routeId, admission.planId, admission.enrollmentId, admission.candidateId, admission.qualificationRunId], '23514', 'email_campaign_admission_lineage');
    await f.db.query('ROLLBACK TO SAVEPOINT lineage');
    await f.db.query('RELEASE SAVEPOINT lineage');
  } finally { await f.db.query('ROLLBACK'); }
  const runtime = f.db;
  await runtime.query('BEGIN');
  await runtime.query('SET LOCAL ROLE app_runtime');
  try {
    await refuses(runtime, 'DELETE FROM outreach_email_campaign_admissions WHERE workspace_id=$1', [w], '42501');
    await refuses(runtime, 'UPDATE outreach_email_campaign_admissions SET admitted_at=now() WHERE workspace_id=$1', [w], '42501');
    await refuses(runtime, 'UPDATE outreach_email_campaigns SET max_enrollments=24 WHERE workspace_id=$1 AND id=$2', [w, admission.campaignId], '42501');
    await refuses(runtime, 'DELETE FROM outreach_email_campaigns WHERE workspace_id=$1', [w], '42501');
  } finally { await runtime.query('ROLLBACK'); }
  console.log('EMAIL_CAMPAIGN_CONSTRAINTS: immutable policy, no false human review, cross-workspace FK, uniqueness, lineage, append-only runtime grants');
}
