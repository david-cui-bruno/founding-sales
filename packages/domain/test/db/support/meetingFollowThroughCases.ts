import { randomUUID } from 'node:crypto';
import { meeting, type CallToBookingFixture } from './callToBookingCases.ts';
type F = CallToBookingFixture;
type Row = Record<string, unknown>;
type Case = { constraint: string; run: (f: F) => Promise<unknown> };
const missing = '00000000-0000-4000-8000-000000004499';
async function insert(f: F, table: string, row: Row) {
  const keys = Object.keys(row);
  return await f.session.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(row));
}
async function plan(f: F): Promise<Row> {
  const meetingId = await meeting(f);
  const firm = (await f.session.query<{ firm_id: string }>('SELECT firm_id FROM meetings WHERE id=$1', [meetingId])).rows[0]!.firm_id;
  return { workspace_id: f.seeded.alpha.workspaceId, id: randomUUID(), meeting_id: meetingId, firm_id: firm, source_hash: 'a'.repeat(64), notes_revision: 0 };
}
async function draft(f: F): Promise<Row> {
  const p = await plan(f); await insert(f, 'meeting_follow_through', p);
  const template = (await f.session.query<{ id: string }>('SELECT id FROM template_versions WHERE workspace_id=$1 LIMIT 1', [f.seeded.alpha.workspaceId])).rows[0]!.id;
  return { workspace_id: p['workspace_id'], id: randomUUID(), plan_id: p['id'], version: 1, subject: 'Meeting recap', body: 'Thanks for the discussion.', rendered_hash: 'b'.repeat(64),
    template_version_id: template, template_content_hash: 'c'.repeat(64), source_hash: 'a'.repeat(64), created_at: '2026-10-05T15:00:00Z', not_before: '2026-10-05T15:30:00Z' };
}
async function task(f: F): Promise<Row> {
  const p = await plan(f); await insert(f, 'meeting_follow_through', p);
  return { workspace_id: p['workspace_id'], id: randomUUID(), meeting_id: p['meeting_id'], firm_id: p['firm_id'], follow_through_plan_id: p['id'],
    label: 'Review unanswered demo', owner_user_id: f.seeded.alpha.salesperson.userId, deadline: JSON.stringify({ precision: 'date', localDate: '2026-10-22', zone: 'America/Chicago' }),
    due_at: '2026-10-23T05:00:00Z', evidence: '[]' };
}
const bad = (table: string, constraint: string, make: (f: F) => Promise<Row>, changes: Row): Case => ({ constraint, run: async f => await insert(f, table, { ...await make(f), ...changes }) });
const twice = (table: string, constraint: string, make: (f: F) => Promise<Row>, changes: () => Row = () => ({})): Case => ({ constraint, run: async f => { const row = await make(f); await insert(f, table, row); return await insert(f, table, { ...row, ...changes() }); } });
export const MEETING_FOLLOW_THROUGH_CONSTRAINT_CASES: readonly Case[] = [
  ...[['source_hash', 'bad'], ['notes_revision', -1], ['version', 0], ['current_draft_version', -1], ['status', 'bad'], ['blockers', '{}']].map(([key, value]) =>
    bad('meeting_follow_through', `meeting_follow_through_${String(key)}_check`, plan, { [String(key)]: value })),
  ...[['workspace_id', 'workspace_id'], ['firm_id', 'workspace_id_meeting_id_firm_id'], ['contact_id', 'workspace_id_contact_id_firm_id'], ['owner_user_id', 'workspace_id_owner_user_id'],
    ['analysis_id', 'workspace_id_analysis_id_meeting_id'], ['sequence_version_id', 'workspace_id_sequence_version_id'], ['permission_id', 'workspace_id_permission_id'], ['enrollment_id', 'workspace_id_enrollment_id']].map(([key, name]) =>
    bad('meeting_follow_through', `meeting_follow_through_${name!}_fkey`, plan, { [key!]: missing })),
  twice('meeting_follow_through', 'meeting_follow_through_pkey', async f => ({ ...await plan(f), status: 'cancelled' })),
  twice('meeting_follow_through', 'meeting_follow_through_one_current', plan, () => ({ id: randomUUID() })),
  { constraint: 'meeting_follow_through_workspace_id_id_meeting_id_key', run: async f => {
    const row = { ...await plan(f), status: 'cancelled' }; await insert(f, 'meeting_follow_through', row);
    await f.session.query('ALTER TABLE meeting_follow_through DROP CONSTRAINT meeting_follow_through_pkey CASCADE');
    return await insert(f, 'meeting_follow_through', row);
  } },
  { constraint: 'meeting_follow_through_workspace_id_enrollment_id_key', run: async f => {
    const enrollment = (await f.session.query<{ id: string }>('SELECT id FROM sequence_enrollments WHERE workspace_id=$1 LIMIT 1', [f.seeded.alpha.workspaceId])).rows[0]!.id;
    await insert(f, 'meeting_follow_through', { ...await plan(f), enrollment_id: enrollment });
    return await insert(f, 'meeting_follow_through', { ...await plan(f), enrollment_id: enrollment });
  } },
  ...[['version', 0], ['ordinal', 4], ['subject', 'Two\nlines'], ['body', ''], ['rendered_hash', 'bad'], ['source_hash', 'bad'], ['template_content_hash','bad'], ['material_task_ids','{}'], ['material_references', '{}'], ['state', 'bad']].map(([key, value]) =>
    bad('meeting_follow_through_drafts', `meeting_follow_through_drafts_${String(key)}_check`, draft, { [String(key)]: value })),
  bad('meeting_follow_through_drafts', 'meeting_follow_through_drafts_check', draft, { not_before: '2026-10-05T14:00:00Z' }),
  bad('meeting_follow_through_drafts', 'meeting_follow_through_drafts_check1', draft, { body: 'Unsubscribe at https://example.test/stop' }),
  bad('meeting_follow_through_drafts', 'meeting_follow_through_drafts_workspace_id_outbound_messag_fkey', draft, { outbound_message_id: missing }),
  bad('meeting_follow_through_drafts', 'meeting_follow_through_drafts_workspace_id_plan_id_fkey', draft, { plan_id: missing }),
  bad('meeting_follow_through_drafts', 'meeting_follow_through_drafts_workspace_id_template_versio_fkey', draft, { template_version_id: missing }),
  bad('meeting_follow_through_drafts', 'meeting_follow_through_drafts_workspace_id_created_by_user_fkey', draft, { created_by_user_id: missing }),
  twice('meeting_follow_through_drafts', 'meeting_follow_through_drafts_pkey', draft, () => ({ version: 2 })),
  twice('meeting_follow_through_drafts', 'meeting_follow_through_drafts_workspace_id_plan_id_version_key', draft, () => ({ id: randomUUID() })),
  twice('meeting_tasks', 'meeting_tasks_one_per_plan', task, () => ({ id: randomUUID() })),
  bad('meeting_tasks', 'meeting_tasks_one_source', task, { commitment_id: 'promise', evidence: '[{}]' }),
  bad('meeting_tasks', 'meeting_tasks_plan_source', task, { follow_through_plan_id: missing }),
];
