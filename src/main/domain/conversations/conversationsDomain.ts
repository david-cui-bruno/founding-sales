import type { AppDatabase } from '../../db/database';
import {
  mutationReceiptSchema,
  type MutationReceipt,
} from '../../../shared/contracts/commonContract';
import {
  attachTranscriptRequestSchema,
  conversationDetailRequestSchema,
  conversationDetailSchema,
  conversationsListRequestSchema,
  conversationsListResponseSchema,
  type AttachTranscriptRequest,
  type ConversationDetail,
  type ConversationDetailRequest,
  type ConversationRow,
  type ConversationsListRequest,
  type ConversationsListResponse,
  type TranscriptSpeaker,
} from '../../../shared/contracts/conversationsContract';
import type { Clock } from '../support/clock';
import type { IdGenerator } from '../support/idGenerator';

export type ConversationsDomainDeps = {
  database: AppDatabase;
  clock: Clock;
  ids: IdGenerator;
};

export type ConversationsDomainErrorCode =
  | 'ACTIVITY_NOT_FOUND'
  | 'TRANSCRIPT_ALREADY_ATTACHED'
  | 'TRANSCRIPT_EMPTY'
  | 'CONVERSATION_CURSOR_INVALID';

/** Safe, renderer-presentable domain error: no SQL, paths, or key material. */
export class ConversationsDomainError extends Error {
  readonly code: ConversationsDomainErrorCode;

  constructor(code: ConversationsDomainErrorCode, message: string) {
    super(message);
    this.name = 'ConversationsDomainError';
    this.code = code;
  }
}

type ActivityRow = {
  id: string;
  person_id: string;
  sales_cycle_id: string | null;
  display_name: string;
  kind: 'call' | 'voicemail';
  direction: 'inbound' | 'outbound';
  occurred_at: string;
  duration_seconds: number | null;
  recording_storage_ref: string | null;
  transcript_storage_ref: string | null;
  metadata_json: string;
};

type ParsedUtterance = {
  speaker: TranscriptSpeaker;
  text: string;
};

const FOUNDER_PREFIX_PATTERN = /^(me|founder):/i;
const LEAD_PREFIX_PATTERN = /^[^:]{1,40}:/;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function jsonSummary(metadataJson: string): string | null {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed !== null && typeof parsed === 'object'
      && typeof (parsed as { summary?: unknown }).summary === 'string') {
      return (parsed as { summary: string }).summary;
    }
  } catch {
    return null;
  }
  return null;
}

function currentRevision(database: AppDatabase): number {
  return (database.raw.prepare(
    'SELECT total_changes() AS count',
  ).get() as { count: number }).count;
}

function toConversationRow(row: ActivityRow): ConversationRow {
  return {
    activityId: row.id,
    personId: row.person_id,
    salesCycleId: row.sales_cycle_id,
    personName: row.display_name,
    kind: row.kind,
    direction: row.direction,
    occurredAt: row.occurred_at,
    durationSeconds: row.duration_seconds,
    recordingAvailable: row.recording_storage_ref !== null,
    transcriptAvailable: row.transcript_storage_ref !== null,
    summary: jsonSummary(row.metadata_json),
  };
}

/**
 * Untrusted pasted text becomes plain utterance rows: split lines, trim,
 * drop empties. `me:`/`founder:` prefixes mark the founder, any short
 * `Name:` prefix marks the lead, and everything else stays unknown with its
 * full text. The text is stored and rendered as data, never interpreted.
 */
export function parseTranscriptUtterances(rawText: string): ParsedUtterance[] {
  const utterances: ParsedUtterance[] = [];
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (FOUNDER_PREFIX_PATTERN.test(trimmed)) {
      const text = trimmed.replace(FOUNDER_PREFIX_PATTERN, '').trim();
      if (text.length > 0) utterances.push({ speaker: 'founder', text });
      continue;
    }
    if (LEAD_PREFIX_PATTERN.test(trimmed)) {
      const text = trimmed.replace(LEAD_PREFIX_PATTERN, '').trim();
      if (text.length > 0) utterances.push({ speaker: 'lead', text });
      continue;
    }
    utterances.push({ speaker: 'unknown', text: trimmed });
  }
  return utterances;
}

const CONVERSATION_BASE_SQL = `
  FROM activities AS activity
  JOIN persons AS person ON person.id = activity.person_id
  WHERE activity.kind IN ('call', 'voicemail')
`;

const FILTER_SQL: Readonly<Record<ConversationsListRequest['filter'], string>> = Object.freeze({
  all: '',
  with_recording: ' AND activity.recording_storage_ref IS NOT NULL',
  with_transcript: ' AND activity.transcript_storage_ref IS NOT NULL',
  without_transcript: ' AND activity.transcript_storage_ref IS NULL',
});

export function listConversations(
  deps: ConversationsDomainDeps,
  input: ConversationsListRequest,
): ConversationsListResponse {
  const request = conversationsListRequestSchema.parse(input);
  const parameters: unknown[] = [];
  let where = CONVERSATION_BASE_SQL + FILTER_SQL[request.filter];
  if (request.query.length > 0) {
    where += ` AND person.display_name LIKE ? ESCAPE '\\'`;
    parameters.push(`%${escapeLike(request.query)}%`);
  }
  const total = (deps.database.raw.prepare(
    `SELECT COUNT(*) AS count ${where}`,
  ).get(...parameters) as { count: number }).count;
  const offset = request.cursor === null ? 0 : Number.parseInt(request.cursor, 10);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ConversationsDomainError(
      'CONVERSATION_CURSOR_INVALID',
      'The list cursor is invalid.',
    );
  }
  const rows = deps.database.raw.prepare(`
    SELECT
      activity.id, activity.person_id, activity.sales_cycle_id,
      person.display_name,
      activity.kind, activity.direction, activity.occurred_at,
      activity.duration_seconds, activity.recording_storage_ref,
      activity.transcript_storage_ref, activity.metadata_json
    ${where}
    ORDER BY activity.occurred_at DESC, activity.id ASC
    LIMIT ? OFFSET ?
  `).all(...parameters, request.limit, offset) as ActivityRow[];
  const nextOffset = offset + rows.length;
  return conversationsListResponseSchema.parse({
    rows: rows.map(toConversationRow),
    total,
    nextCursor: nextOffset < total ? String(nextOffset) : null,
    revision: currentRevision(deps.database),
  });
}

function readConversationActivity(
  database: AppDatabase,
  activityId: string,
): ActivityRow | undefined {
  return database.raw.prepare(`
    SELECT
      activity.id, activity.person_id, activity.sales_cycle_id,
      person.display_name,
      activity.kind, activity.direction, activity.occurred_at,
      activity.duration_seconds, activity.recording_storage_ref,
      activity.transcript_storage_ref, activity.metadata_json
    FROM activities AS activity
    JOIN persons AS person ON person.id = activity.person_id
    WHERE activity.id = ? AND activity.kind IN ('call', 'voicemail')
  `).get(activityId) as ActivityRow | undefined;
}

export function getConversationDetail(
  deps: ConversationsDomainDeps,
  input: ConversationDetailRequest,
): ConversationDetail {
  const request = conversationDetailRequestSchema.parse(input);
  const activity = readConversationActivity(deps.database, request.activityId);
  if (activity === undefined) {
    throw new ConversationsDomainError(
      'ACTIVITY_NOT_FOUND',
      'The conversation does not exist.',
    );
  }
  const transcript = deps.database.raw.prepare(`
    SELECT id, source, created_at FROM transcripts WHERE activity_id = ?
  `).get(request.activityId) as {
    id: string; source: 'manual_paste'; created_at: string;
  } | undefined;
  return conversationDetailSchema.parse({
    ...toConversationRow(activity),
    transcript: transcript === undefined ? null : {
      transcriptId: transcript.id,
      source: transcript.source,
      createdAt: transcript.created_at,
      utterances: (deps.database.raw.prepare(`
        SELECT id, sequence, speaker, text FROM transcript_utterances
        WHERE transcript_id = ? ORDER BY sequence ASC
      `).all(transcript.id) as Array<{
        id: string; sequence: number; speaker: TranscriptSpeaker; text: string;
      }>).map((utterance) => ({
        id: utterance.id,
        sequence: utterance.sequence,
        speaker: utterance.speaker,
        text: utterance.text,
      })),
    },
  });
}

/**
 * Manual transcript recovery. One immediate transaction writes the consent
 * record (`policy_kind='recording'`, `decision='granted'`, versioned
 * `manual-attach-v1`), the transcript, its utterances, and then points the
 * activity's transcript evidence columns at them, which satisfies the
 * activities CHECK requiring a consent record next to a transcript ref.
 */
export function attachTranscript(
  deps: ConversationsDomainDeps,
  input: AttachTranscriptRequest,
): MutationReceipt {
  const request = attachTranscriptRequestSchema.parse(input);
  return deps.database.raw.transaction(() => {
    const activity = readConversationActivity(deps.database, request.activityId);
    if (activity === undefined || activity.person_id !== request.personId) {
      throw new ConversationsDomainError(
        'ACTIVITY_NOT_FOUND',
        'The conversation does not exist for this person.',
      );
    }
    if (activity.transcript_storage_ref !== null) {
      throw new ConversationsDomainError(
        'TRANSCRIPT_ALREADY_ATTACHED',
        'The conversation already has a transcript.',
      );
    }
    const utterances = parseTranscriptUtterances(request.rawText);
    if (utterances.length === 0) {
      throw new ConversationsDomainError(
        'TRANSCRIPT_EMPTY',
        'The pasted text contains no utterances.',
      );
    }
    const now = deps.clock.now();
    const consentId = deps.ids.next();
    const transcriptId = deps.ids.next();
    deps.database.raw.prepare(`
      INSERT INTO consent_policy_records (
        id, person_id, activity_id, policy_kind, policy_version,
        effective_at, decision, evidence_json, created_at
      ) VALUES (?, ?, ?, 'recording', 'manual-attach-v1', ?, 'granted', ?, ?)
    `).run(
      consentId,
      activity.person_id,
      activity.id,
      now,
      JSON.stringify({ kind: 'founder_manual_attach' }),
      now,
    );
    deps.database.raw.prepare(`
      INSERT INTO transcripts (
        id, activity_id, person_id, source, format_version, raw_text, created_at
      ) VALUES (?, ?, ?, 'manual_paste', 1, ?, ?)
    `).run(transcriptId, activity.id, activity.person_id, request.rawText, now);
    const insertUtterance = deps.database.raw.prepare(`
      INSERT INTO transcript_utterances (
        id, transcript_id, sequence, speaker, text
      ) VALUES (?, ?, ?, ?, ?)
    `);
    utterances.forEach((utterance, sequence) => {
      insertUtterance.run(
        deps.ids.next(), transcriptId, sequence, utterance.speaker, utterance.text,
      );
    });
    deps.database.raw.prepare(`
      UPDATE activities
      SET transcript_storage_ref = ?, consent_policy_record_id = ?
      WHERE id = ?
    `).run(`db:transcripts/${transcriptId}`, consentId, activity.id);
    return mutationReceiptSchema.parse({
      revision: currentRevision(deps.database),
      affectedPersonIds: [activity.person_id],
      affectedSalesCycleIds: activity.sales_cycle_id === null ? [] : [activity.sales_cycle_id],
    });
  }).immediate();
}
