import { uuid } from '@fss/contracts';
import type { AdminInvocation, AdminOutcome } from './admin.ts';

/**
 * `fss admin meetings attendance-report --workspace-id <uuid>`: what the attendance
 * correction (lane M1, migration 0039) will change, as counts only.
 *
 * Why it exists: Cal.com's `MEETING_ENDED` fires at a booking's scheduled end, so every
 * stored `held` meeting, and every `meeting.held` funnel fact, came from the clock rather
 * than from anyone attending (`meetings/calcom.ts`, and the reconciliation's synthesized
 * end in `meetings/reconcile.ts`). Separately, `meeting.booked` stage evidence has moved
 * deals to Demo booked and opened opportunities. Production has no read-only SQL path, so
 * this is the read that sizes the correction before the release that makes it.
 *
 * It prints one JSON line of counts and nothing else: no name, e-mail, uid or id, because
 * the operations task's log is CloudWatch. One READ ONLY transaction, rolled back; it
 * writes nothing and decides nothing.
 */

/** Every state `meetings_state_known` allows (0039 added `ended`), so a zero is printed as a zero. */
const MEETING_STATES = ['booked', 'rescheduled', 'cancelled', 'ended', 'held', 'no_show'] as const;

export async function meetingsAttendanceReportCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const workspaceId = invocation.options['--workspace-id'] ?? '';
  if (!uuid.safeParse(workspaceId).success) {
    return { ok: false, reason: 'workspace_unknown', detail: '--workspace-id is a workspace uuid' };
  }
  const { session } = invocation;
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const workspace = await session.query('SELECT 1 FROM workspaces WHERE id = $1::uuid', [workspaceId]);
    if (workspace.rows.length === 0) return { ok: false, reason: 'workspace_unknown', detail: 'no workspace has that id' };

    const byState = await session.query<{ state: string; count: string }>(
      'SELECT state, count(*)::text AS count FROM meetings WHERE workspace_id = $1::uuid GROUP BY state',
      [workspaceId],
    );
    const meetings = await session.query<{ held_past: string; held_future: string; no_show_after_held: string }>(
      `SELECT count(*) FILTER (WHERE state = 'held' AND ends_at < now())::text AS held_past,
              count(*) FILTER (WHERE state = 'held' AND ends_at >= now())::text AS held_future,
              count(*) FILTER (WHERE state_before_no_show = 'held')::text AS no_show_after_held
         FROM meetings
        WHERE workspace_id = $1::uuid`,
      [workspaceId],
    );
    // Since 0039 a wrong fact is withdrawn rather than removed: `meetingHeldFacts` counts the
    // live ones, `meetingHeldFactsWithdrawn` the rest; `meetingBookedFacts` counts the live ones too.
    const facts = await session.query<{ held: string; held_withdrawn: string; booked: string }>(
      `SELECT count(*) FILTER (WHERE kind = 'meeting.held' AND withdrawn_at IS NULL)::text AS held,
              count(*) FILTER (WHERE kind = 'meeting.held' AND withdrawn_at IS NOT NULL)::text AS held_withdrawn,
              count(*) FILTER (WHERE kind = 'meeting.booked' AND withdrawn_at IS NULL)::text AS booked
         FROM funnel_facts
        WHERE workspace_id = $1::uuid AND kind IN ('meeting.held', 'meeting.booked')`,
      [workspaceId],
    );
    const ended = await session.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM calcom_events
        WHERE workspace_id = $1::uuid AND trigger_event = 'MEETING_ENDED' AND outcome = 'applied'`,
      [workspaceId],
    );
    // `applyStageEvidence` writes one evidence row per stage event a booking caused, with the
    // meeting's id as the evidence id. The opening event of an opportunity is the one with no
    // `from_stage_id`; every other event is a move of one that already existed.
    const evidence = await session.query<{ meetings: string; opened: string; moved: string }>(
      `SELECT count(DISTINCT e.evidence_id)::text AS meetings,
              count(DISTINCT e.opportunity_id) FILTER (WHERE s.from_stage_id IS NULL)::text AS opened,
              count(DISTINCT e.opportunity_id) FILTER (WHERE s.from_stage_id IS NOT NULL)::text AS moved
         FROM opportunity_stage_evidence e
         JOIN opportunity_stage_events s ON s.workspace_id = e.workspace_id AND s.id = e.stage_event_id
        WHERE e.workspace_id = $1::uuid AND e.evidence_kind = 'meeting.booked'`,
      [workspaceId],
    );
    // The same opening, as the audit trail recorded it: a cross-check on the join above.
    const openedAudit = await session.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_events
        WHERE workspace_id = $1::uuid AND action = 'opportunity.opened_by_evidence'
          AND detail->>'evidenceKind' = 'meeting.booked'`,
      [workspaceId],
    );

    const count = (value: string | undefined): number => Number(value ?? '0');
    const meetingsByState: Record<string, number> = Object.fromEntries(MEETING_STATES.map(state => [state, 0]));
    for (const row of byState.rows) meetingsByState[row.state] = count(row.count);
    return {
      ok: true,
      value: {
        meetingsByState,
        heldEndedInPast: count(meetings.rows[0]?.held_past),
        heldEndingInFuture: count(meetings.rows[0]?.held_future),
        noShowBeforeHeld: count(meetings.rows[0]?.no_show_after_held),
        meetingHeldFacts: count(facts.rows[0]?.held),
        meetingHeldFactsWithdrawn: count(facts.rows[0]?.held_withdrawn),
        meetingBookedFacts: count(facts.rows[0]?.booked),
        calcomMeetingEndedApplied: count(ended.rows[0]?.count),
        meetingsWithBookedEvidence: count(evidence.rows[0]?.meetings),
        opportunitiesOpenedByBookedEvidence: count(evidence.rows[0]?.opened),
        opportunitiesMovedByBookedEvidence: count(evidence.rows[0]?.moved),
        opportunitiesOpenedByBookedEvidenceAudited: count(openedAudit.rows[0]?.count),
      },
    };
  } finally {
    await session.query('ROLLBACK');
  }
}
