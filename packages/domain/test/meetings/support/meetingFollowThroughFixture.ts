import { randomUUID } from 'node:crypto';
import type { MeetingNoteItem } from '@fss/contracts';
import { templateContentHash } from '../../../src/rules/templates.ts';
import { withTransaction } from '../../../db/queryable.ts';
import { updateSetting } from '../../../settings/store.ts';
import { meetingTasksFixture } from './meetingTasksFixture.ts';

export const RECAP_AT = '2026-10-05T15:00:00.000Z';
export async function meetingFollowThroughFixture() {
  const f = await meetingTasksFixture();
  const template = async (body = 'Thanks for our conversation.\n\n{meeting_recap}\n\nSam Example\nCallie', approved = true) => {
    const templateId = randomUUID(), subject = 'Our conversation';
    return (await f.db.session.query<{ id: string }>(`INSERT INTO template_versions(workspace_id,template_id,version,name,subject,body,content_hash,footer_sign_off,required_variables,approved_at,approved_by_user_id)
      VALUES($1,$2,1,'Demo recap',$3,$4,$5,'Sam Example\nCallie',ARRAY['meeting_recap'],CASE WHEN $6 THEN now() END,CASE WHEN $6 THEN $7::uuid END) RETURNING id`,
    [f.workspace, templateId, subject, body, templateContentHash({ templateId, version: 1, subject, body }), approved, f.seeded.alpha.admin.userId])).rows[0]!.id;
  };
  const sequence = async (templateId: string) => {
    const sequenceId = (await f.db.session.query<{ id: string }>("INSERT INTO sequences(workspace_id,name,created_by_user_id) VALUES($1,$2,$3) RETURNING id", [f.workspace, randomUUID(), f.seeded.alpha.admin.userId])).rows[0]!.id;
    const id = (await f.db.session.query<{ id: string }>('INSERT INTO sequence_versions(workspace_id,sequence_id,version) VALUES($1,$2,1) RETURNING id', [f.workspace, sequenceId])).rows[0]!.id;
    for (let n = 1; n <= 3; n++) await f.db.session.query(`INSERT INTO sequence_steps(workspace_id,sequence_version_id,ordinal,channel,delay_unit,delay_amount,template_version_id)
      VALUES($1,$2,$3,'email','elapsed',$4,$5)`, [f.workspace, id, n, (n - 1) * 168, templateId]);
    await f.db.session.query("UPDATE sequence_versions SET state='published',published_at=now(),published_by_user_id=$3 WHERE workspace_id=$1 AND id=$2", [f.workspace, id, f.seeded.alpha.admin.userId]);
    return id;
  };
  const ready = async (options: { body?: string; items?: readonly MeetingNoteItem[]; approved?: boolean } = {}) => {
    const meetingId = await f.meeting();
    const contactId = (await f.db.session.query<{ id: string }>("INSERT INTO contacts(workspace_id,firm_id,full_name) VALUES($1,$2,'Pat Example') RETURNING id", [f.workspace, f.firmId])).rows[0]!.id;
    await f.db.session.query("UPDATE firms SET time_zone='America/Chicago',time_zone_confidence='high',time_zone_source='recorded',time_zone_rule_version='fixture' WHERE id=$1", [f.firmId]);
    await f.db.session.query(`UPDATE meetings SET starts_at='2026-10-05T14:00:00Z',ends_at='2026-10-05T14:20:00Z',contact_id=$2,state='held',attendance_source='manual',attendance_confirmed_at='2026-10-05T14:20:00Z',attendance_confirmed_by=$3 WHERE id=$1`, [meetingId, contactId, f.seeded.alpha.admin.userId]);
    const quote = 'After-hours calls interrupt the manager. I will send the maintenance guide tomorrow.';
    await f.save(meetingId, quote);
    const item: MeetingNoteItem = { id: 'need', kind: 'need', text: 'After-hours calls interrupt the manager.', provenance: 'stated', owner: 'prospect', deadline: null, deadlineText: null, reviewReasons: [], evidence: [{ kind: 'debrief', revision: 1, quote: 'After-hours calls interrupt the manager.', startOffset: 0, endOffset: 38 }] };
    const analysis = await f.publish(meetingId, options.items ?? [item]);
    const templateId = await template(options.body, options.approved);
    const sequenceVersionId = await sequence(templateId);
    const configured = await withTransaction(f.db.session, () => updateSetting(f.context, { settingKey: 'meeting_follow_through', value: { sequenceVersionId }, changeNote: 'Synthetic fixture' }));
    if (!configured.ok) throw new Error(configured.reason);
    return { ...analysis, contactId, templateId, sequenceVersionId };
  };
  return { ...f, ready, template, sequence };
}
