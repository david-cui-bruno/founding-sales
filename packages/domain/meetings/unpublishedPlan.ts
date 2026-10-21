import { meetingUnpublishedPlanSchema, saveMeetingUnpublishedPlanSchema, type SaveMeetingUnpublishedPlan } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { MeetingResult } from './outcomeTypes.ts';
import { lockMeetingFollowThrough } from './followThrough.ts';
import type { FollowThroughRow } from './followThroughTypes.ts';

/** Unknowns are descriptions for the owner, never inferred answers or permission. */
export function unpublishedUnknownFields(subject: string, body: string): string[] {
  const fields: string[] = [];
  if (subject.trim() === '') fields.push('Subject needs human entry');
  if (body.trim() === '') fields.push('Message needs human entry');
  for (const field of (subject + '\n' + body).match(/\{[^{}]*\}?|[^{}\s]+\}/gu) ?? []) fields.push(field.slice(0, 200));
  if (/[{}]/u.test(subject + '\n' + body) && fields.every(field => !/[{}]/u.test(field))) fields.push('Unresolved curly field needs human entry');
  return [...new Set(fields)].slice(0, 30);
}

/** Caller owns the transaction. This path never writes sending-related tables or wake times. */
export async function saveMeetingUnpublishedPlan(context: RepositoryContext, raw: SaveMeetingUnpublishedPlan, at = new Date().toISOString()): Promise<MeetingResult<{ meetingId: string; planId: string; version: number }>> {
  const parsed = saveMeetingUnpublishedPlanSchema.safeParse(raw);
  if (!parsed.success || context.scope.actor.kind !== 'user') return { ok: false, reason: 'invalid_input' };
  const input = parsed.data;
  const locked = await lockMeetingFollowThrough(context, input.meetingId);
  if (!locked.ok) return locked;
  const outcomes = locked.value;
  if (outcomes.sourceHash !== input.expectedSourceHash || outcomes.notes.revision !== input.expectedNotesRevision) return { ok: false, reason: 'source_changed' };
  let plan = (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE', [context.scope.workspaceId, input.meetingId])).rows[0];
  if (plan !== undefined && ['cancelled', 'completed'].includes(plan.status)) return { ok: false, reason: 'follow_up_stopped' };
  if ((plan?.version ?? 0) !== input.expectedPlanVersion) return { ok: false, reason: 'draft_changed' };
  const previous = plan?.['unpublished_plan'] == null ? null : meetingUnpublishedPlanSchema.parse(plan['unpublished_plan']);
  if ((previous?.revision ?? 0) !== input.expectedUnpublishedRevision) return { ok: false, reason: 'draft_changed' };
  const offsets = [0, 3, 7, 14];
  const unpublished = meetingUnpublishedPlanSchema.parse({ schemaVersion: 1, state: 'unpublished', cadence: 'post_demo_3_7_14',
    sourceHash: outcomes.sourceHash, notesRevision: outcomes.notes.revision, revision: (previous?.revision ?? 0) + 1, savedAt: at,
    messages: input.messages.map((message, index) => ({ ...message, ordinal: index + 1, elapsedDays: offsets[index], held: true,
      unknownFields: unpublishedUnknownFields(message.subject, message.body) })),
  });
  if (plan === undefined) {
    // Explicitly dormant: saving drafts does not queue work or configure a legacy sequence.
    plan = (await context.db.query<FollowThroughRow>(`INSERT INTO meeting_follow_through(workspace_id,meeting_id,firm_id,contact_id,owner_user_id,source_hash,notes_revision,analysis_id,status,approval_mode,next_wake_at,created_at,updated_at)
      SELECT m.workspace_id,m.id,m.firm_id,m.contact_id,f.assigned_user_id,$3,$4,$5,'held','human','9999-01-01T00:00:00Z'::timestamptz,$6,$6
      FROM meetings m JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id WHERE m.workspace_id=$1 AND m.id=$2 RETURNING *`,
    [context.scope.workspaceId, input.meetingId, outcomes.sourceHash, outcomes.notes.revision, outcomes.analysisId, at])).rows[0];
    if (plan === undefined) return { ok: false, reason: 'meeting_unknown' };
  }
  const row = (await context.db.query<{ version: number }>('UPDATE meeting_follow_through SET unpublished_plan=$3::jsonb,version=version+1,updated_at=$4 WHERE workspace_id=$1 AND id=$2 RETURNING version',
    [context.scope.workspaceId, plan.id, JSON.stringify(unpublished), at])).rows[0]!;
  return { ok: true, value: { meetingId: input.meetingId, planId: plan.id, version: row.version } };
}
