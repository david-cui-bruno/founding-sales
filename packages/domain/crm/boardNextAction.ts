import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * A board card's next action (Kanban slice K, fold 1): the earliest of four things the
 * product already stores, and never a store of its own.
 *
 *   * an **open callback** (`callbacks`, `dial/callbacks.ts`) — "Call back";
 *   * the next **pending step execution** of an active enrollment (`step_executions`,
 *     sequences) — "Follow-up e-mail" or "Call" by channel;
 *   * an **upcoming meeting** (`meetings`, call-to-booking W): booked or rescheduled and
 *     starting after now — "Demo";
 *   * an **open call item in the newest Today snapshot that has one** (`today_items`, kind `call_due`)
 *     — "Call".
 *
 * An overdue callback, step or call item still counts: it is what is next, and the card
 * shows it as late. A meeting in the past does not: it is history, not an action. Ties go
 * to the order above. Returns one entry per firm that has any, and nothing for one that
 * has none, so the card shows nothing rather than a dash.
 */

export type NextActionKind = 'callback' | 'follow_up_email' | 'call' | 'demo';

export interface NextAction {
  readonly kind: NextActionKind;
  readonly label: string;
  readonly dueAt: string;
}

const LABELS: Readonly<Record<NextActionKind, string>> = {
  callback: 'Call back',
  follow_up_email: 'Follow-up e-mail',
  call: 'Call',
  demo: 'Demo',
};

interface Candidate {
  readonly firm_id: string;
  readonly kind: NextActionKind;
  readonly due_at: Date;
  readonly src: number;
  readonly [column: string]: unknown;
}

export async function readNextActions(
  context: RepositoryContext,
  now: Date = new Date(),
): Promise<Readonly<Record<string, NextAction>>> {
  const workspaceId = context.scope.workspaceId;
  const { rows } = await context.db.query<Candidate>(
    `SELECT firm_id, 'callback' AS kind, due_at, 0 AS src
       FROM callbacks WHERE workspace_id = $1 AND status = 'open'
     UNION ALL
     SELECT x.firm_id, CASE x.channel WHEN 'email' THEN 'follow_up_email' ELSE 'call' END, x.due_at, 1
       FROM step_executions x
       JOIN sequence_enrollments e ON e.workspace_id = x.workspace_id AND e.id = x.enrollment_id
      WHERE x.workspace_id = $1 AND x.state = 'pending' AND e.state = 'active'
     UNION ALL
     SELECT firm_id, 'demo', starts_at, 2
       FROM meetings
      WHERE workspace_id = $1 AND firm_id IS NOT NULL AND state IN ('booked', 'rescheduled') AND starts_at > $2
     UNION ALL
     SELECT i.firm_id, 'call', i.due_at, 3
       FROM today_items i
      WHERE i.workspace_id = $1 AND i.kind = 'call_due' AND i.status = 'open'
        AND i.snapshot_date = (SELECT max(snapshot_date) FROM today_items WHERE workspace_id = $1 AND kind = 'call_due')`,
    [workspaceId, now.toISOString()],
  );
  // Rows are taken in source order (`src`: callback, step, demo, queue) and only a strictly earlier row replaces
  // the one held, so on equal instants the earlier source keeps the card.
  const best = new Map<string, Candidate>();
  for (const row of [...rows].sort((a, b) => a.src - b.src)) {
    const held = best.get(row.firm_id);
    if (held === undefined || row.due_at.getTime() < held.due_at.getTime()) best.set(row.firm_id, row);
  }
  const out: Record<string, NextAction> = {};
  for (const [firmId, candidate] of best) {
    out[firmId] = { kind: candidate.kind, label: LABELS[candidate.kind], dueAt: candidate.due_at.toISOString() };
  }
  return out;
}
