import { randomUUID } from 'node:crypto';
import { createOutboundWorld } from '../../outbound/support/outboundWorld.ts';
import { seedFirm } from '../../outbound/support/dispatchFixtures.ts';
import { repositoryContext, workspaceScope } from '../../../db/workspaceScope.ts';
import { withTransaction } from '../../../db/queryable.ts';
import { templateContentHash } from '../../../src/rules/templates.ts';
import { updateSetting } from '../../../settings/store.ts';
import { saveMeetingNotes } from '../../../meetings/notes.ts';
import { assembleMeetingAnalysisInput } from '../../../meetings/analysisInput.ts';
import { materializeMeetingAnalysis } from '../../../meetings/analysisRequests.ts';
import { validateMeetingAnalysisAnswer } from '../../../meetings/analysisModel.ts';
import { prepareMeetingRecap,editMeetingRecap } from '../../../meetings/followThrough.ts';
import { enrollMeetingFollowThrough } from '../../../meetings/followThroughEligibility.ts';
import { readFenceByStepExecution, readOutboundOutcome, prepareOutboundMessage } from '../../../outbound/fence.ts';
import type { SendHandoff } from '../../../sequences/sendHandoff.ts';
import { composeEligibility } from '../../../sequences/eligibility.ts';
import { runDueStepExecution } from '../../../sequences/executions.ts';

export async function preparedMeetingFixture(options: { steps?: number; material?: string; paused?: boolean } = {}) {
  const world = await createOutboundWorld(), db = world.database.session, workspace = world.alpha.workspace.workspaceId;
  const context = world.systemContext(workspace);
  const admin = repositoryContext(workspaceScope(workspace, { kind: 'user', userId: world.alpha.workspace.admin.userId, role: 'admin' }), db);
  const firm = await seedFirm(world, world.alpha, 'meeting');
  await db.query("UPDATE firms SET time_zone='Etc/UTC',time_zone_confidence='high',time_zone_source='recorded',time_zone_rule_version='fixture' WHERE id=$1", [firm.firmId]);
  const now = new Date(); while (now.getUTCDay() === 0 || now.getUTCDay() === 6) now.setUTCDate(now.getUTCDate() + 1); now.setUTCHours(10, 0, 0, 0);
  const at = now.toISOString(), before = new Date(Date.now() - 86_400_000).toISOString();
  const meetingId = randomUUID();
  await db.query(`INSERT INTO meetings(workspace_id,id,booking_uid,current_booking_uid,firm_id,contact_id,opportunity_id,state,starts_at,ends_at,last_event_at,attendance_source,attendance_confirmed_at,attendance_confirmed_by)
    VALUES($1,$2,$3,$3,$4,$5,$6,'held',$7::timestamptz-interval '20 minutes',$7,$7,'manual',$7,$8)`, [workspace, meetingId, randomUUID().replaceAll('-', ''), firm.firmId, firm.contactId, firm.opportunityId, before, world.alpha.workspace.admin.userId]);
  const quote = 'After-hours calls interrupt our manager.';
  await withTransaction(db, () => saveMeetingNotes(admin, { meetingId, expectedRevision: 0, debrief: quote, sufficient: true, speakerMappings: [], itemOverrides: [] }));
  const input = await assembleMeetingAnalysisInput(context, { meetingId }); if (!input.ok) throw new Error(input.reason);
  const items = validateMeetingAnalysisAnswer(JSON.stringify({ overview: quote, reviewReasons: [], items: [{ id: 'need', kind: 'need', text: quote, owner: 'prospect', provenance: 'stated', deadline: null, deadlineText: null, reviewReasons: [], evidence: [{ kind: 'debrief', revision: 1, quote, startOffset: 0, endOffset: quote.length }] }] }), input.value);
  if (!items.ok) throw new Error(items.reason);
  const analysis = await withTransaction(db, () => materializeMeetingAnalysis(context, { meetingId, at })); if (!analysis.ok) throw new Error(analysis.reason);
  await db.query("UPDATE meeting_analyses SET state='ready',items=$2::jsonb,source_complete=true,tasks_pending=false WHERE id=$1", [analysis.value.analysisId, JSON.stringify(items.value.items)]);
  const templateId = randomUUID(), subject = 'Our meeting', body = `Thanks for meeting.\n\n{meeting_recap}${options.material === undefined ? '' : `\n\n${options.material}`}\n\nSigned off`;
  const templateVersionId = (await db.query<{ id: string }>(`INSERT INTO template_versions(workspace_id,template_id,version,name,subject,body,content_hash,footer_sign_off,required_variables,approved_at,approved_by_user_id)
    VALUES($1,$2,1,'Meeting recap',$3,$4,$5,'Signed off',ARRAY['meeting_recap'],now(),$6) RETURNING id`, [workspace, templateId, subject, body, templateContentHash({ templateId, version: 1, subject, body }), world.alpha.workspace.admin.userId])).rows[0]!.id;
  const sequenceId = (await db.query<{ id: string }>('INSERT INTO sequences(workspace_id,name,created_by_user_id) VALUES($1,$2,$3) RETURNING id', [workspace, randomUUID(), world.alpha.workspace.admin.userId])).rows[0]!.id;
  const sequenceVersionId = (await db.query<{ id: string }>('INSERT INTO sequence_versions(workspace_id,sequence_id,version) VALUES($1,$2,1) RETURNING id', [workspace, sequenceId])).rows[0]!.id;
  await db.query("INSERT INTO sequence_steps(workspace_id,sequence_version_id,ordinal,channel,delay_unit,delay_amount,template_version_id) VALUES($1,$2,1,'email','elapsed',0,$3)", [workspace, sequenceVersionId, templateVersionId]);
  for (let n = 2; n <= (options.steps ?? 1); n++) {
    const id = randomUUID(), text = 'Following up on our conversation. Is there a useful next step?\n\nSigned off';
    const template = (await db.query<{ id: string }>(`INSERT INTO template_versions(workspace_id,template_id,version,name,subject,body,content_hash,footer_sign_off,required_variables,approved_at,approved_by_user_id)
      VALUES($1,$2,1,'Nudge','Following up',$3,$4,'Signed off','{}',now(),$5) RETURNING id`, [workspace, id, text, templateContentHash({ templateId: id, version: 1, subject: 'Following up', body: text }), world.alpha.workspace.admin.userId])).rows[0]!.id;
    await db.query("INSERT INTO sequence_steps(workspace_id,sequence_version_id,ordinal,channel,delay_unit,delay_amount,template_version_id) VALUES($1,$2,$3,'email','elapsed',$4,$5)", [workspace, sequenceVersionId, n, n * 168, template]);
  }
  await db.query("UPDATE sequence_versions SET state='published',published_at=now(),published_by_user_id=$2 WHERE id=$1", [sequenceVersionId, world.alpha.workspace.admin.userId]);
  await withTransaction(db, () => updateSetting(admin, { settingKey: 'meeting_follow_through', value: { sequenceVersionId }, changeNote: 'Fixture' }));
  if (options.paused) await db.query('UPDATE sending_domains SET automated_sending_enabled=false,automated_sending_enabled_at=NULL WHERE workspace_id=$1',[workspace]);
  const prepared = await withTransaction(db, () => prepareMeetingRecap(admin, { meetingId, expectedSourceHash: input.value.sourceHash, at: new Date(now.getTime() - 40 * 60_000).toISOString() }));
  if (!prepared.ok || prepared.value.currentDraft === null) throw new Error(`prepare: ${JSON.stringify(prepared)}`);
  const approved=await withTransaction(db,()=>editMeetingRecap(admin,{planId:prepared.value.planId!,expectedPlanVersion:prepared.value.version,expectedDraftVersion:prepared.value.currentDraft!.version,action:'approve',expectedApprovalHash:prepared.value.approvalHash!},prepared.value.currentDraft!.createdAt));
  if(!approved.ok)throw new Error(`approval: ${approved.reason}`);
  return { world, db, workspace, context, admin, ...firm, meetingId, at, before, planId: prepared.value.planId!, version: approved.value.version, templateVersionId, draft: prepared.value.currentDraft };
}
export async function meetingDispatchFixture(options: { steps?: number; material?: string } = {}) {
  const f = await preparedMeetingFixture(options);
  const { db, context, admin, at } = f;
  const enrolled = await withTransaction(db, () => enrollMeetingFollowThrough(admin, { planId: f.planId, expectedVersion: f.version, at }));
  if (!enrolled.ok) throw new Error(`enroll: ${enrolled.reason}`);
  const executionId = (await db.query<{ id: string }>('SELECT id FROM step_executions WHERE enrollment_id=$1', [enrolled.value.enrollmentId])).rows[0]!.id;
  await db.query('UPDATE step_executions SET due_at=$2,not_before=$2 WHERE id=$1', [executionId, at]);
  const handoff: SendHandoff = {
    prepare: async (c, request) => { const result = await prepareOutboundMessage(c, request); return result.ok ? { ok: true, ...result.value } : { ok: false, reason: 'template_unapproved' }; },
    dispatch: async () => ({ ok: true }), readOutcome: readOutboundOutcome,
  };
  const prepare = async () => {
    const result = await withTransaction(db, () => runDueStepExecution(context, { stepExecutionId: executionId, now: at, eligibility: composeEligibility(), sendHandoff: handoff }));
    if (result.kind !== 'handed_to_send') throw new Error(`step: ${JSON.stringify(result)}`);
    return (await readFenceByStepExecution(context, executionId))!;
  };
  return { ...f, executionId, prepare };
}
