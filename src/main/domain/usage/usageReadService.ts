import type { AppDatabase } from '../../db/database';
import { accountFingerprint } from '../accounts/accountEvidence';
import { actualAccountCallOutcomes } from '../../../shared/contracts/accountOutboundContract';
import { localDateIn } from '../../../shared/contracts/accountCallbackContract';
import { threadProjectionSchema } from '../../../shared/contracts/mailThreadContract';
import { workerEventSchema } from '../../../shared/contracts/delegationContract';
import { templateSequenceEmailTemplateId } from '../../../shared/outreach/templateSequenceEmail';
import { resolveLocalWeekInterval } from '../today/todayOrdering';
import { usageHoldReasons, usageSummarySchema, type UsageHoldReason, type UsageOutcomeCounts, type UsageSummary, type UsageWindow } from '../../../shared/contracts/usageContract';

type Row = Record<string, unknown>;
const realOutcomes: ReadonlySet<string> = new Set(actualAccountCallOutcomes);

/**
 * The weekly summary, derived. Read-only: it prepares no identity, writes no row
 * and opens no transaction of its own, so the daily read can call it inside its
 * own deferred one. Nothing here reads the worker, a clock or the filesystem.
 *
 * Every count comes from a record the desktop cannot silently rewrite:
 * `delegated_manual_handoffs.consumed_at` for a placed call, an immutable
 * `delegated_manual_outcomes` row paired with its immutable applied event for an
 * outcome and its note, `pm_account_callbacks` for a promise, the saved draft
 * rows for drafts and holds, `delegated_action_outcomes` for a sequence email the
 * provider accepted, and the stored thread projections for replies.
 * A record whose stored event fingerprint does not match is not evidence of
 * anything and is skipped, exactly as the actual-call evidence reader skips it.
 */
export function readUsageSummary(database: AppDatabase, input: {
  workspaceId: string;
  /** The firms the daily read listed this morning, already workspace-scoped. The summary never widens that scope. */
  accountIds: readonly string[];
  generatedAt: string;
  timezone: string;
}): UsageSummary {
  const accountIds = [...new Set(input.accountIds)];
  const window = (weeksBack: number) => readWindow(database, { ...input, accountIds, weeksBack });
  return usageSummarySchema.parse({ timezone: input.timezone, thisWeek: window(0), lastWeek: window(1) });
}

function readWindow(database: AppDatabase, input: {
  workspaceId: string; accountIds: readonly string[]; generatedAt: string; timezone: string; weeksBack: number;
}): UsageWindow {
  const week = resolveLocalWeekInterval({ generatedAt: input.generatedAt, timezone: input.timezone, weeksBack: input.weeksBack });
  const scope = new Set(input.accountIds);
  const mornings = new Set<string>();
  const firms = new Set<string>();
  const holds = new Map<UsageHoldReason, number>();
  const outcomes: UsageOutcomeCounts = { connected: 0, interested: 0, not_interested: 0, gatekeeper: 0, voicemail: 0, no_answer: 0, busy: 0, wrong_number: 0 };
  let callsPlaced = 0, notes = 0, drafts = 0, replies = 0, callbacksPromised = 0, callbacksKept = 0, emailsSent = 0;
  const rows = (sql: string, ...args: (string | number)[]) => database.raw.prepare(sql).all(...args) as Row[];
  /** A fact happened for this firm on this local date. Unreadable instants are not facts. */
  const record = (accountId: unknown, instant: unknown) => {
    if (typeof accountId !== 'string' || !scope.has(accountId) || typeof instant !== 'string') return false;
    let date: string;
    try { date = localDateIn(instant, input.timezone); } catch { return false; }
    if (date < week.localWeekStart || date > week.localWeekEnd) return false;
    mornings.add(date);
    firms.add(accountId);
    return true;
  };
  const hold = (reason: UsageHoldReason) => holds.set(reason, (holds.get(reason) ?? 0) + 1);

  for (const row of rows('SELECT account_id,consumed_at FROM delegated_manual_handoffs WHERE workspace_id=? AND channel=? AND consumed_at IS NOT NULL AND consumed_at>=? AND consumed_at<?',
    input.workspaceId, 'call', week.startAt, week.endAt)) {
    if (record(row.account_id, row.consumed_at)) callsPlaced += 1;
  }

  // The outcome projection and its applied event are both append-only and immutable. Pairing them by
  // identity and fingerprint is what makes a stored outcome evidence rather than a row somebody wrote.
  for (const row of rows(`SELECT o.account_id,o.outcome_json,o.observed_at,e.event_json,e.fingerprint
      FROM delegated_manual_outcomes o
      JOIN delegated_applied_events e ON e.id=o.event_id AND e.workspace_id=o.workspace_id AND e.account_id=o.account_id AND e.stream='execution'
      WHERE o.workspace_id=? AND o.channel='call' AND o.observed_at>=? AND o.observed_at<?
      ORDER BY o.observed_at,o.event_id`, input.workspaceId, week.startAt, week.endAt)) {
    try {
      const event = workerEventSchema.parse(JSON.parse(String(row.event_json)));
      if (event.kind !== 'manual.outcome' || accountFingerprint(event) !== row.fingerprint) continue;
      const outcome = event.payload;
      if (outcome.channel !== 'call' || outcome.observedAt !== row.observed_at
        || accountFingerprint(outcome) !== accountFingerprint(JSON.parse(String(row.outcome_json)))) continue;
      if (!record(row.account_id, outcome.observedAt)) continue;
      if (realOutcomes.has(outcome.outcome)) outcomes[outcome.outcome as keyof UsageOutcomeCounts] += 1;
      if (typeof outcome.replyText === 'string' && outcome.replyText.trim().length > 0) notes += 1;
    } catch { /* A corrupt local record is not evidence that a call happened. */ }
  }

  // `created_at` and `due_on` are frozen by the schema-29 triggers, so a closed promise still
  // reports the week it was made in and the week it was promised for.
  for (const row of rows('SELECT account_id,created_at FROM pm_account_callbacks WHERE created_at>=? AND created_at<?', week.startAt, week.endAt)) {
    if (record(row.account_id, row.created_at)) callbacksPromised += 1;
  }
  for (const row of rows("SELECT account_id,due_on FROM pm_account_callbacks WHERE state='done' AND due_on>=? AND due_on<=?", week.localWeekStart, week.localWeekEnd)) {
    if (typeof row.account_id === 'string' && scope.has(row.account_id)) { callbacksKept += 1; firms.add(row.account_id); }
  }

  for (const row of rows('SELECT account_id,updated_at FROM delegated_reply_drafts WHERE workspace_id=? AND updated_at>=? AND updated_at<?',
    input.workspaceId, week.startAt, week.endAt)) {
    if (record(row.account_id, row.updated_at)) drafts += 1;
  }
  for (const row of rows('SELECT account_id,updated_at,approval_json FROM delegated_requested_followup_drafts WHERE workspace_id=? AND updated_at>=? AND updated_at<?',
    input.workspaceId, week.startAt, week.endAt)) {
    if (!record(row.account_id, row.updated_at)) continue;
    drafts += 1;
    // Exactly the reason the daily read puts on an unapproved requested follow-up.
    if (row.approval_json === null) hold('requires_owner_preflight');
  }
  for (const row of rows("SELECT account_id,updated_at FROM manual_linkedin_drafts WHERE workspace_id=? AND state<>'closed' AND updated_at>=? AND updated_at<?",
    input.workspaceId, week.startAt, week.endAt)) {
    if (record(row.account_id, row.updated_at)) hold('manual_only');
  }

  // A sequence email that actually went out. The template id is the one the worker-minted action id names,
  // so a row that is not a template sequence action is not counted here at all (D13, lane 40).
  for (const row of rows("SELECT account_id,action_id,observed_at FROM delegated_action_outcomes WHERE workspace_id=? AND state='provider_accepted' AND observed_at>=? AND observed_at<?",
    input.workspaceId, week.startAt, week.endAt)) {
    if (templateSequenceEmailTemplateId(row.action_id) === null) continue;
    if (record(row.account_id, row.observed_at)) emailsSent += 1;
  }

  // A reply is counted from the message the worker observed, not from when the desktop stored it,
  // so a thread that arrived late still counts on the day the firm actually answered.
  for (const row of rows('SELECT account_id,projection_json,updated_at FROM delegated_threads WHERE workspace_id=? ORDER BY account_id,id', input.workspaceId)) {
    try {
      const projection = threadProjectionSchema.parse(JSON.parse(String(row.projection_json)));
      if (!projection.signals.length) continue;
      const cited = new Set(projection.signals.flatMap(signal => signal.evidence.map(evidence => evidence.messageId)));
      for (const message of projection.thread.messages) {
        if (cited.has(message.id) && record(row.account_id, message.date)) replies += 1;
      }
      // Today holds every reply until the reply capability is verified, whatever the draft says.
      if (record(row.account_id, row.updated_at)) hold('reply_capability_unverified');
    } catch { /* A corrupt stored projection is not an observed reply. */ }
  }

  return {
    from: week.localWeekStart, to: week.localWeekEnd,
    mornings: mornings.size, firms: firms.size, callsPlaced, outcomes, notes,
    callbacksPromised, callbacksKept, drafts, emailsSent, replies,
    holds: [...usageHoldReasons].sort().flatMap(reason => {
      const value = holds.get(reason);
      return value === undefined ? [] : [{ reason, count: value }];
    }),
  };
}
