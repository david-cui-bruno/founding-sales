import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CampaignOpeningPolicy } from '@fss/contracts';
import { createAuthFixture } from '../../../../apps/api/test/support/authFixture.ts';
import { seedEmailCampaign, seedCampaignResearch } from '../../../../apps/web/test/support/emailCampaignSeed.ts';
import type { ThinHostApp } from '../../../../apps/web/test/support/thinHostApp.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { approveEmailCampaign } from '../../outreach/emailCampaign.ts';
import { createQualifiedResearchFirm } from '../../sourcing/qualifiedResearch.ts';
import { readTemplateVersion } from '../../templates/templates.ts';
import { readCurrentCampaignOpening } from '../../outreach/campaignOpeningSource.ts';
import { placeEmailSend } from '../../src/rules/sendingWindow.ts';

/** PG-only reuse of accepted 741 seed owners. Both helpers read only app.fixture,
 * as inspected here. No browser server/assets/HTTPS/Chrome is started by this
 * adapter. The existing auth fixture owns its Google stub and actual database.
 * NOT executed until root allocates the PG slot. */
export async function campaignOpeningPgFixture(policyEnabled = true) {
  const fixture = await createAuthFixture();
  try {
    const app = { fixture } as ThinHostApp;
    const prepared = await seedEmailCampaign(app);
    const admin = prepared.context, db = fixture.db, w = fixture.alpha.workspaceId;
    const tx = <T>(work: () => Promise<T>) => withTransaction(db, work);
    const approved = await tx(() => approveEmailCampaign(admin, prepared.policy));
    assert(approved.ok, approved.ok ? '' : approved.reason);
    const source = await seedCampaignResearch(app, `opening-${randomUUID()}`);
    const made = await tx(() => createQualifiedResearchFirm(admin, source.selection));
    assert(made.ok, made.ok ? '' : made.reason);
    const admission = (await db.query<{ enrollment_id: string; plan_id: string }>('SELECT enrollment_id,plan_id FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND firm_id=$2', [w, made.value.firmId])).rows[0];
    assert(admission, 'ordinary qualified create must automatically admit before any opening work');
    const execution = (await db.query<{ id: string }>('SELECT id FROM step_executions WHERE workspace_id=$1 AND enrollment_id=$2 AND ordinal=1', [w, admission.enrollment_id])).rows[0];
    assert(execution);
    const template = await readTemplateVersion(admin, prepared.templateIds[0]!); assert(template);
    const policy: CampaignOpeningPolicy = { id: randomUUID(), workspaceId: w, ownerUserId: fixture.alpha.admin.userId,
      campaignId: approved.value.campaignId, campaignRevision: 1, sequenceVersionId: prepared.policy.sequenceVersionId,
      templateVersionId: template.id, templateContentHash: template.contentHash, revision: 1, mode: 'approved_variant_selection_v1',
      firstEmailOnly: true, variants: [{ id: 'local', text: 'I noticed {{firm_name}} serves {{firm_locality}}, {{firm_region}}.' }],
      approvedAt: new Date().toISOString(), expiresAt: prepared.policy.expiresAt };
    if (policyEnabled) await db.query('INSERT INTO outreach_campaign_opening_policies(workspace_id,id,campaign_id,policy) VALUES($1,$2,$3,$4::jsonb)', [w, policy.id, policy.campaignId, JSON.stringify(policy)]);
    // Only the fictional clock placement is controlled. Real source/policy expiry
    // still uses database wall time, and no owner sending switch is enabled.
    await db.query('UPDATE step_executions SET due_at=clock_timestamp()-interval \'1 second\',not_before=clock_timestamp()-interval \'1 second\' WHERE workspace_id=$1 AND id=$2', [w, execution.id]);
    const worker = repositoryContext(workspaceScope(w, { kind: 'system', component: 'worker' }), db);
    const current = await readCurrentCampaignOpening(worker, execution.id);
    assert.equal(current.kind, policyEnabled ? 'current' : 'exact_template');
    const enrollment = (await db.query<{ firm_time_zone: string }>('SELECT firm_time_zone FROM sequence_enrollments WHERE workspace_id=$1 AND id=$2', [w, admission.enrollment_id])).rows[0]!;
    const at = placeEmailSend(new Date().toISOString(), enrollment.firm_time_zone, { prospecting: true }).sendAt;
    return { fixture, db, w, admin, worker, tx, source, policy, template, firmId: made.value.firmId,
      enrollmentId: admission.enrollment_id, planId: admission.plan_id, executionId: execution.id, at, stop: () => fixture.stop() };
  } catch (error) { await fixture.stop(); throw error; }
}
