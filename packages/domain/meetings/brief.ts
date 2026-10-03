import {
  MEETING_BRIEF_SECTION_MAX,
  type CallAnalysisResponse,
  type CallSummaryDto,
  type MeetingBriefItem,
  type MeetingBriefResponse,
  type MeetingBriefSection,
  type PreparedBriefDto,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readCallAnalysis } from '../calls/analysis.ts';
import { readAnalysisSummaries } from '../calls/analysisPaid.ts';
import { readCallSummaries } from '../calls/summary.ts';
import { readFirmForActor } from '../crm/dto.ts';
import { readPreparedBrief } from '../crm/preparedBriefs.ts';
import { listFirmFacts, type FirmFactDto } from '../research/brief.ts';
import { MEETING_COLUMNS, type MeetingRow } from './calcom.ts';

/**
 * The meeting brief (lane M2): `GET /meetings/brief?meetingId=`. Assembled on read from what
 * is stored; no model is called and nothing is written but the firm-read audit row an
 * administrator's read of a colleague's firm owes (`readFirmForActor`).
 *
 * Who may read it: whoever may read the firm page in full — the firm's assignee or an
 * administrator. Anyone else, an unknown meeting and a meeting matched to no firm are all
 * the same null (the route's `not_found`): a brief is never evidence that a colleague's
 * firm has a meeting.
 *
 * Sections, each capped at `MEETING_BRIEF_SECTION_MAX` with the rest counted in `omitted`:
 *
 *   * **Why this demo** — the booker's notes and answers (`stated`), the `demo_request`
 *     signals' quotes from the recent calls' analyses (`observed`), and those calls' summary
 *     next steps (`inferred`), newest call first.
 *   * **Firm** — the prepared brief's first lines (`unverified`: prepared research, not
 *     verified by Callie; it is free text, so its headline is its first lines), then the
 *     research facts `software_evidence` and `maintenance_workflow` (`observed` quotes).
 *   * **Previous conversations** — the last three logged calls (outcome and a one-line
 *     summary) and the last two e-mail threads (subject and date only).
 *   * **Objections** — the recent calls' analyses' objections, one per category, the most
 *     recent quote kept, with its date.
 *   * **Open commitments** — the recent calls' summaries' commitments, de-duplicated.
 */

/** How many of the firm's most recent calls the brief reads analyses and summaries of. */
export const MEETING_BRIEF_RECENT_CALLS = 10;
const PREVIOUS_CALLS = 3;
const PREVIOUS_THREADS = 2;
const PREPARED_BRIEF_LINES = 3;
const FIRM_FACT_KEYS: readonly string[] = ['software_evidence', 'maintenance_workflow'];
const ONE_LINE_MAX = 200;
const ITEM_TEXT_MAX = 1_200;

type ThreadRow = {
  readonly subject: string | null;
  readonly last_at: Date;
};

const cut = (text: string, max: number): string => {
  const characters = [...text.trim()];
  return characters.length <= max ? characters.join('') : `${characters.slice(0, max - 1).join('')}…`;
};

/** The first sentence, or the first line, cut to one line's length. */
function oneLine(text: string): string {
  const firstLine = text.split(/\r?\n/u).find(line => line.trim().length > 0) ?? text;
  const sentence = /^(.+?[.!?])(\s|$)/u.exec(firstLine.trim())?.[1] ?? firstLine;
  return cut(sentence, ONE_LINE_MAX);
}

const normalized = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

function section(items: readonly MeetingBriefItem[]): MeetingBriefSection {
  return { items: items.slice(0, MEETING_BRIEF_SECTION_MAX), omitted: Math.max(0, items.length - MEETING_BRIEF_SECTION_MAX) };
}

function item(fields: Omit<MeetingBriefItem, 'label' | 'sourceUrl' | 'text'> & { text: string; label?: string | null; sourceUrl?: string | null }): MeetingBriefItem {
  return {
    label: fields.label === undefined || fields.label === null ? null : cut(fields.label, 200),
    text: cut(fields.text, ITEM_TEXT_MAX),
    source: fields.source,
    provenance: fields.provenance,
    at: fields.at,
    sourceUrl: fields.sourceUrl ?? null,
  };
}

/** Everything the brief reads, gathered; `assembleMeetingBrief` is pure over it. */
export interface MeetingBriefSources {
  readonly meeting: Pick<
    MeetingRow,
    'id' | 'state' | 'starts_at' | 'ends_at' | 'event_title' | 'attendee_name' | 'booking_notes' | 'booking_answers' | 'location_type'
  > & { readonly firm_id: string; readonly created_at: Date };
  /** The firm's most recent calls, newest first. */
  readonly calls: readonly BriefCall[];
  /** By call session: the stored summary (`call_summaries`), with its next steps. */
  readonly storedSummaries: ReadonlyMap<string, CallSummaryDto>;
  /** By call session: the current analysis's summary, preferred for the one-line summary. */
  readonly analysedSummaries: ReadonlyMap<string, CallSummaryDto>;
  /** By call session: the analysis read (its authoritative result holds signals and objections). */
  readonly analyses: ReadonlyMap<string, CallAnalysisResponse>;
  readonly prepared: PreparedBriefDto | null;
  readonly facts: readonly FirmFactDto[];
  /** The firm's most recent e-mail threads, newest first. */
  readonly threads: readonly { readonly subject: string | null; readonly at: Date }[];
  readonly now: Date;
}

export interface BriefCall {
  /** The logged outcome, or null for a call session nobody logged yet. */
  readonly outcome: string | null;
  readonly at: Date;
  readonly sessionId: string | null;
}

/** The brief, or null when the meeting is unknown, matched to no firm, or not the caller's to read. */
export async function readMeetingBrief(context: RepositoryContext, meetingId: string): Promise<MeetingBriefResponse | null> {
  if (!/^[0-9a-f-]{36}$/iu.test(meetingId)) return null;
  const { rows: meetings } = await context.db.query<MeetingRow & { created_at: Date }>(
    `SELECT ${MEETING_COLUMNS}, created_at FROM meetings WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, meetingId],
  );
  const meeting = meetings[0];
  if (meeting === undefined || meeting.firm_id === null) return null;
  const firmId = meeting.firm_id;
  const read = await readFirmForActor(context, { firmId });
  if (!read.ok || read.value.visibility !== 'assigned_or_admin') return null;

  const calls = await recentCalls(context, firmId);
  const sessionIds = calls.flatMap(call => (call.sessionId === null ? [] : [call.sessionId]));
  const analyses = new Map<string, CallAnalysisResponse>();
  for (const sessionId of sessionIds) {
    // Serially: `context.db` may be one connection inside a transaction.
    const analysis = await readCallAnalysis(context, sessionId);
    if (analysis !== null) analyses.set(sessionId, analysis);
  }
  return assembleMeetingBrief({
    meeting: { ...meeting, firm_id: firmId },
    calls,
    storedSummaries: await readCallSummaries(context, sessionIds),
    analysedSummaries: await readAnalysisSummaries(context, sessionIds),
    analyses,
    prepared: await readPreparedBrief(context, firmId),
    facts: await listFirmFacts(context, firmId),
    threads: await recentThreads(context, firmId),
    now: new Date(),
  });
}

/** The brief from its sources. Pure. */
export function assembleMeetingBrief(sources: MeetingBriefSources): MeetingBriefResponse {
  const { meeting, calls, storedSummaries, analysedSummaries, analyses } = sources;
  const dated = (call: BriefCall): string => call.at.toISOString();
  const bookedAt = meeting.created_at.toISOString();
  const resultOf = (call: BriefCall) => (call.sessionId === null ? null : (analyses.get(call.sessionId)?.authoritative?.result ?? null));
  // The history read's choice: the current analysis's summary, else the stored one.
  const summaryOf = (call: BriefCall): CallSummaryDto | undefined =>
    call.sessionId === null ? undefined : (analysedSummaries.get(call.sessionId) ?? storedSummaries.get(call.sessionId));

  // ---- Why this demo ----------------------------------------------------------------
  const why: MeetingBriefItem[] = [];
  if (meeting.booking_notes !== null) {
    why.push(item({ label: 'Notes', text: meeting.booking_notes, source: 'booking_notes', provenance: 'stated', at: bookedAt }));
  }
  for (const [question, answer] of Object.entries(meeting.booking_answers ?? {})) {
    why.push(item({ label: question, text: answer, source: 'booking_answer', provenance: 'stated', at: bookedAt }));
  }
  for (const call of calls) {
    for (const signal of resultOf(call)?.interest.signals ?? []) {
      if (signal.kind !== 'demo_request') continue;
      why.push(item({ label: 'Asked for a demo', text: signal.ref.quote, source: 'call_signal', provenance: 'observed', at: dated(call) }));
    }
  }
  for (const call of calls) {
    // Next steps are the stored summary's: an analysis's summary carries none.
    const steps = call.sessionId === null ? [] : (storedSummaries.get(call.sessionId)?.nextSteps ?? []);
    for (const step of steps) {
      const owner = step.owner === 'you' ? 'You' : step.owner === 'them' ? 'They' : null;
      const text = step.due === null ? step.action : `${step.action} (${step.due})`;
      why.push(item({ label: owner === null ? 'Next step' : `Next step · ${owner}`, text, source: 'call_next_step', provenance: 'inferred', at: dated(call) }));
    }
  }

  // ---- Firm ---------------------------------------------------------------------------
  const firm: MeetingBriefItem[] = [];
  const prepared = sources.prepared;
  if (prepared !== null) {
    const lines = prepared.brief
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .slice(0, PREPARED_BRIEF_LINES);
    for (const line of lines) {
      firm.push(
        item({ label: 'Prepared research', text: line, source: 'prepared_brief', provenance: 'unverified', at: prepared.observedOn, sourceUrl: prepared.sources[0]?.url ?? null }),
      );
    }
  }
  for (const fact of sources.facts) {
    if (!FIRM_FACT_KEYS.includes(fact.key) || fact.quote === null) continue;
    firm.push(
      item({
        label: fact.key === 'software_evidence' ? 'Software' : 'Maintenance workflow',
        text: fact.quote,
        source: 'research_fact',
        provenance: 'observed',
        at: fact.retrievedAt,
        sourceUrl: fact.sourceReference,
      }),
    );
  }

  // ---- Previous conversations ---------------------------------------------------------
  const conversations: MeetingBriefItem[] = [];
  for (const call of calls.slice(0, PREVIOUS_CALLS)) {
    const summary = summaryOf(call);
    conversations.push(
      item({
        label: call.outcome,
        text: summary === undefined ? 'No summary' : oneLine(summary.summary),
        source: 'call',
        provenance: summary === undefined ? 'observed' : 'inferred',
        at: dated(call),
      }),
    );
  }
  for (const thread of sources.threads.slice(0, PREVIOUS_THREADS)) {
    conversations.push(item({ label: 'E-mail', text: thread.subject ?? '(no subject)', source: 'email_thread', provenance: 'observed', at: thread.at.toISOString() }));
  }

  // ---- Objections: one per category, the most recent ----------------------------------
  const objections: MeetingBriefItem[] = [];
  const seenCategories = new Set<string>();
  for (const call of calls) {
    for (const objection of resultOf(call)?.objections ?? []) {
      if (seenCategories.has(objection.category)) continue;
      seenCategories.add(objection.category);
      objections.push(item({ label: objection.category, text: objection.ref.quote, source: 'call_objection', provenance: 'observed', at: dated(call) }));
    }
  }

  // ---- Open commitments: the summaries', de-duplicated --------------------------------
  const commitments: MeetingBriefItem[] = [];
  const seenCommitments = new Set<string>();
  for (const call of calls) {
    for (const commitment of summaryOf(call)?.commitments ?? []) {
      const key = normalized(commitment.quote);
      if (seenCommitments.has(key)) continue;
      seenCommitments.add(key);
      commitments.push(
        item({ label: commitment.speaker === 'you' ? 'You' : 'They', text: commitment.quote, source: 'call_commitment', provenance: 'observed', at: dated(call) }),
      );
    }
  }

  return {
    meetingId: meeting.id,
    firmId: meeting.firm_id,
    meeting: {
      title: meeting.event_title,
      attendeeName: meeting.attendee_name,
      state: meeting.state,
      startsAt: meeting.starts_at.toISOString(),
      endsAt: meeting.ends_at.toISOString(),
      locationType: meeting.location_type,
    },
    sections: {
      whyThisDemo: section(why),
      firm: section(firm),
      conversations: section(conversations),
      objections: section(objections),
      commitments: section(commitments),
    },
    generatedAt: sources.now.toISOString(),
  };
}

/**
 * The firm's most recent calls, newest first: every logged call (with its call session, if
 * it had one) and every placed call session nobody has logged yet, as the call history
 * lists them (`calls/sessions.ts`).
 */
async function recentCalls(context: RepositoryContext, firmId: string): Promise<readonly BriefCall[]> {
  const { rows } = await context.db.query<{ outcome: string | null; at: Date; session_id: string | null }>(
    `SELECT outcome, at, session_id FROM (
       SELECT l.outcome, l.occurred_at AS at, s.id AS session_id, l.id AS tie
         FROM call_logs l
         LEFT JOIN LATERAL (
           SELECT cs.id FROM call_sessions cs
            WHERE cs.workspace_id = l.workspace_id AND cs.call_log_id = l.id
            ORDER BY cs.consumed_at DESC NULLS LAST, cs.id LIMIT 1
         ) s ON true
        WHERE l.workspace_id = $1 AND l.firm_id = $2
       UNION ALL
       SELECT NULL, COALESCE(cs.started_at, cs.consumed_at), cs.id, cs.id
         FROM call_sessions cs
        WHERE cs.workspace_id = $1 AND cs.firm_id = $2 AND cs.consumed_at IS NOT NULL AND cs.call_log_id IS NULL
     ) calls
     ORDER BY at DESC, tie
     LIMIT $3`,
    [context.scope.workspaceId, firmId, MEETING_BRIEF_RECENT_CALLS],
  );
  return rows.map(row => ({ outcome: row.outcome, at: row.at, sessionId: row.session_id }));
}

/**
 * The firm's two most recent e-mail threads: the newest message's subject and date of each.
 * A message belongs to the firm as on the firm's timeline (`crm/firmActivity.ts`): matched
 * to it, and not a candidate a person ruled out.
 */
async function recentThreads(context: RepositoryContext, firmId: string): Promise<readonly { readonly subject: string | null; readonly at: Date }[]> {
  const { rows } = await context.db.query<ThreadRow>(
    `SELECT DISTINCT ON (m.mailbox_id, m.provider_thread_id) m.subject, m.internal_date AS last_at
       FROM mail_messages m
      WHERE m.workspace_id = $1
        AND EXISTS (
          SELECT 1 FROM mail_message_matches x
           WHERE x.workspace_id = m.workspace_id AND x.mail_message_id = m.id AND x.firm_id = $2
             AND x.selected IS NOT FALSE AND (NOT x.ambiguous OR x.selected IS TRUE))
      ORDER BY m.mailbox_id, m.provider_thread_id, m.internal_date DESC, m.id`,
    [context.scope.workspaceId, firmId],
  );
  return [...rows]
    .sort((left, right) => right.last_at.getTime() - left.last_at.getTime())
    .slice(0, PREVIOUS_THREADS)
    .map(row => ({ subject: row.subject, at: row.last_at }));
}
