import {
  CALL_POLICY_VERSION,
  callAnalysisResultSchema,
  callProposalSetSchema,
  transcriptIsChannelLabelled,
  type CallAnalysisFailureReason,
  type CallAnalysisNotes,
  type CallAnalysisOrigin,
  type CallAnalysisRequestedReason,
  type CallAnalysisResponse,
  type CallAnalysisResult,
  type CallAnalysisState,
  type CallProposal,
  type CallTranscriptUtterance,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate, readFirm } from '../crm/firms.ts';
import {
  CALL_ANALYSIS_MAX_TRANSCRIPT_BYTES,
  CALL_ANALYSIS_PROMPT_VERSION,
  CALL_ANALYSIS_SCHEMA_VERSION,
  numberedTranscriptText,
  readCallAnalysisAnswer,
  transcriptSha256,
  type CallAnalysisModel,
} from './analysisModel.ts';
import { proposeEffects, type CallPolicyContext } from './analysisPolicy.ts';

/**
 * The post-call analysis record (slice 3a, migration 0035): its production writers and its read.
 *
 * ## The writers, and the one lock order
 *
 * Every write of a call's analysis takes, in this order:
 *
 *   1. the call's **firm** row, `FOR UPDATE` (`loadFirmForUpdate`);
 *   2. the advisory lock **`call_analysis:<session>`** (`lockCallAnalysis`, keyed
 *      `<workspace>:call_analysis:<session>` like the summary's);
 *   3. the **session** row, `FOR KEY SHARE` (the analysis's foreign key needs it to stay);
 *   4. the analysis rows.
 *
 * That is the paid pattern's order (firm → `call_analysis:<session>` → session KEY SHARE →
 * budget → monthly → rows, DESIGN-S3A §2.1) and the prefix of Lane B's apply order (… →
 * firm → `call_analysis:<session>` → session row). Re-taking a lock the transaction already
 * holds is free, so the paid chunk can take 1-3 itself and then call `completeCallAnalysis`.
 *
 *   * `createAnalysisVersion` writes a `pending` model version, or a completed user version
 *     (David's notes);
 *   * `completeCallAnalysis` runs, under the same locks, the reader, then `proposeEffects`,
 *     and writes `completed` with the result, the proposals and their hash; an unreadable
 *     answer, or a transcript that changed under it, writes `failed`;
 *   * `failCallAnalysis` closes a pending version without an answer (the paid path's
 *     refusals and exhaustion).
 *
 * ## Current notes and the authoritative analysis
 *
 *   * **Current notes**: the latest user version, otherwise the latest completed model
 *     version. A model version completed after an edit is stored and listed, and never
 *     replaces David's notes (C5).
 *   * **Authoritative**: the latest completed model version whose `transcript_sha256` is the
 *     current transcript's. Its stored proposals and hash are what an Apply is checked
 *     against; the hash is never recomputed.
 */

/** Model versions one call may ever have (the paid cap: DESIGN-S3A §2.1). */
export const CALL_ANALYSIS_MAX_MODEL_VERSIONS = 3;

export function callAnalysisLockKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:call_analysis:${sessionId}`;
}

/** The advisory lock `call_analysis:<session>`. Step 2 of the order above: after the firm row. */
export async function lockCallAnalysis(context: RepositoryContext, sessionId: string): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    callAnalysisLockKey(context.scope.workspaceId, sessionId),
  ]);
}

export interface Locked {
  readonly firmId: string;
  readonly permitted: boolean;
}

/**
 * Steps 1-3 for one session: firm, analysis lock, session KEY SHARE. Null when the session
 * (or its firm) is gone. `permitted` is the firm rule for a user actor, true for the system.
 */
export async function lockCallAnalysisForSession(context: RepositoryContext, sessionId: string): Promise<Locked | null> {
  const { rows: located } = await context.db.query<{ firm_id: string }>(
    'SELECT firm_id FROM call_sessions WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, sessionId],
  );
  const firmId = located[0]?.firm_id;
  if (firmId === undefined) return null;
  const firm = await loadFirmForUpdate(context, firmId);
  if (firm === null) return null;
  await lockCallAnalysis(context, sessionId);
  const { rows: live } = await context.db.query<{ firm_id: string }>(
    'SELECT firm_id FROM call_sessions WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE',
    [context.scope.workspaceId, sessionId],
  );
  // A session moved to another firm between the unlocked read and the lock (a firm merge)
  // is read again from the top rather than written under the wrong firm's lock.
  if (live[0] === undefined) return null;
  if (live[0].firm_id !== firmId) return await lockCallAnalysisForSession(context, sessionId);
  const permitted = context.scope.actor.kind !== 'user' || decideFirmMutation(context, firm).permitted;
  return { firmId, permitted };
}

export interface StoredTranscript {
  readonly channelLabelled: boolean;
  readonly utterances: readonly CallTranscriptUtterance[];
  readonly sha256: string;
}

export async function readStoredTranscript(context: RepositoryContext, sessionId: string): Promise<StoredTranscript | null> {
  const { rows } = await context.db.query<{ provider: string; model: string; utterances: unknown }>(
    'SELECT provider, model, utterances FROM call_transcripts WHERE workspace_id = $1 AND call_session_id = $2',
    [context.scope.workspaceId, sessionId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const utterances = Array.isArray(row.utterances) ? (row.utterances as CallTranscriptUtterance[]) : [];
  return { channelLabelled: transcriptIsChannelLabelled(row), utterances, sha256: transcriptSha256(utterances) };
}

async function nextVersion(context: RepositoryContext, sessionId: string): Promise<number> {
  const { rows } = await context.db.query<{ v: number }>(
    'SELECT coalesce(max(version), 0)::int AS v FROM call_analyses WHERE workspace_id = $1 AND call_session_id = $2',
    [context.scope.workspaceId, sessionId],
  );
  return (rows[0]?.v ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// createAnalysisVersion
// ---------------------------------------------------------------------------

export type CreateAnalysisVersionInput =
  | {
      readonly sessionId: string;
      readonly origin: 'model';
      readonly reason: Exclude<CallAnalysisRequestedReason, 'user_edit'>;
      /** The model the version will be asked of; the one that answers is recorded at completion. */
      readonly model: CallAnalysisModel;
      readonly requestedByUserId?: string | undefined;
    }
  | {
      readonly sessionId: string;
      readonly origin: 'user';
      readonly reason: 'user_edit';
      readonly notes: CallAnalysisNotes;
    };

export type CreateAnalysisVersionOutcome =
  | { readonly kind: 'created'; readonly analysisId: string; readonly version: number }
  /** A model version is already pending: one at a time per call. */
  | { readonly kind: 'in_flight'; readonly analysisId: string; readonly version: number }
  | { readonly kind: 'capped' }
  | { readonly kind: 'not_permitted' }
  /** No such session, no transcript, or one that is not channel-labelled, empty or too long. */
  | { readonly kind: 'not_applicable'; readonly reason: 'session_unknown' | CallAnalysisFailureReason };

/**
 * A new version of a call's analysis, under `call_analysis:<session>`: a `pending` model
 * version, or a completed user version holding David's notes.
 */
export async function createAnalysisVersion(
  context: RepositoryContext,
  input: CreateAnalysisVersionInput,
): Promise<CreateAnalysisVersionOutcome> {
  const locked = await lockCallAnalysisForSession(context, input.sessionId);
  if (locked === null) return { kind: 'not_applicable', reason: 'session_unknown' };
  if (!locked.permitted) return { kind: 'not_permitted' };
  const transcript = await readStoredTranscript(context, input.sessionId);

  if (input.origin === 'user') {
    if (context.scope.actor.kind !== 'user') return { kind: 'not_permitted' };
    const version = await nextVersion(context, input.sessionId);
    const { rows } = await context.db.query<{ id: string }>(
      `INSERT INTO call_analyses
         (workspace_id, call_session_id, version, origin, requested_reason, requested_by_user_id,
          transcript_sha256, state, notes, completed_at)
       VALUES ($1, $2, $3, 'user', 'user_edit', $4, $5, 'completed', $6::jsonb, now())
       RETURNING id`,
      [
        context.scope.workspaceId,
        input.sessionId,
        version,
        context.scope.actor.userId,
        transcript?.sha256 ?? null,
        JSON.stringify({ summary: input.notes.summary.trim(), facts: input.notes.facts.map(fact => fact.trim()) }),
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('the user version was not written');
    return { kind: 'created', analysisId: id, version };
  }

  if (transcript === null) return { kind: 'not_applicable', reason: 'transcript_missing' };
  if (!transcript.channelLabelled) return { kind: 'not_applicable', reason: 'not_channel_labelled' };
  if (transcript.utterances.length === 0) return { kind: 'not_applicable', reason: 'transcript_missing' };
  if (Buffer.byteLength(numberedTranscriptText(transcript.utterances), 'utf8') > CALL_ANALYSIS_MAX_TRANSCRIPT_BYTES) {
    return { kind: 'not_applicable', reason: 'transcript_too_long' };
  }
  const { rows: existing } = await context.db.query<{ id: string; version: number; state: CallAnalysisState }>(
    `SELECT id, version, state FROM call_analyses
      WHERE workspace_id = $1 AND call_session_id = $2 AND origin = 'model'`,
    [context.scope.workspaceId, input.sessionId],
  );
  const pending = existing.find(row => row.state === 'pending');
  if (pending !== undefined) return { kind: 'in_flight', analysisId: pending.id, version: pending.version };
  if (existing.length >= CALL_ANALYSIS_MAX_MODEL_VERSIONS) return { kind: 'capped' };
  const version = await nextVersion(context, input.sessionId);
  const requester = input.requestedByUserId ?? (context.scope.actor.kind === 'user' ? context.scope.actor.userId : null);
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO call_analyses
       (workspace_id, call_session_id, version, origin, requested_reason, requested_by_user_id,
        transcript_sha256, model, prompt_version, schema_version, policy_version, state)
     VALUES ($1, $2, $3, 'model', $4, $5, $6, $7, $8, $9, $10, 'pending')
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.sessionId,
      version,
      input.reason,
      requester,
      transcript.sha256,
      input.model.toLowerCase(),
      CALL_ANALYSIS_PROMPT_VERSION,
      CALL_ANALYSIS_SCHEMA_VERSION,
      CALL_POLICY_VERSION,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the model version was not written');
  return { kind: 'created', analysisId: id, version };
}

// ---------------------------------------------------------------------------
// completeCallAnalysis and failCallAnalysis
// ---------------------------------------------------------------------------

export type CompleteCallAnalysisOutcome =
  | {
      readonly kind: 'completed';
      readonly analysisId: string;
      readonly version: number;
      readonly proposalHash: string;
      readonly proposals: number;
      readonly dropped: number;
    }
  | { readonly kind: 'failed'; readonly analysisId: string; readonly reason: CallAnalysisFailureReason }
  /** The version is already completed or failed, or is not a model version: nothing written. */
  | { readonly kind: 'not_pending'; readonly state: CallAnalysisState | null }
  /** The session (and with it the version) is gone. */
  | { readonly kind: 'gone' };

type PendingRow = {
  readonly id: string;
  readonly call_session_id: string;
  readonly version: number;
  readonly origin: CallAnalysisOrigin;
  readonly state: CallAnalysisState;
  readonly transcript_sha256: string | null;
};

/** Steps 1-3 for the version's session, then the version row itself, FOR UPDATE. */
async function lockVersion(context: RepositoryContext, analysisId: string): Promise<PendingRow | 'gone'> {
  const { rows: located } = await context.db.query<{ call_session_id: string }>(
    'SELECT call_session_id FROM call_analyses WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, analysisId],
  );
  const sessionId = located[0]?.call_session_id;
  if (sessionId === undefined) return 'gone';
  const locked = await lockCallAnalysisForSession(context, sessionId);
  if (locked === null) return 'gone';
  const { rows } = await context.db.query<PendingRow>(
    `SELECT id, call_session_id, version, origin, state, transcript_sha256
       FROM call_analyses WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, analysisId],
  );
  return rows[0] ?? 'gone';
}

async function writeFailed(context: RepositoryContext, analysisId: string, reason: CallAnalysisFailureReason): Promise<void> {
  await context.db.query(
    `UPDATE call_analyses SET state = 'failed', failure_reason = $3, completed_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'pending'`,
    [context.scope.workspaceId, analysisId, reason],
  );
}

export interface CompleteCallAnalysisInput {
  readonly analysisId: string;
  /** The model's answer text, exactly as received. */
  readonly rawAnswer: string;
  /** The transcript the request carried; it must be the version's revision. */
  readonly utterances: readonly CallTranscriptUtterance[];
  readonly policyContext: CallPolicyContext;
  /** The model that answered, when the response named one (recorded on the version). */
  readonly answeredBy?: string | undefined;
}

/**
 * Complete a pending model version: under `call_analysis:<session>`, read the answer
 * (`readCallAnalysisAnswer`), propose (`proposeEffects`), and write `completed` with the
 * result, the proposals and their hash. A malformed or schema-invalid answer, or a
 * transcript — carried by the request, or stored now — other than the one the version was
 * created on, writes `failed`. A version
 * that is no longer pending is left as it is.
 */
export async function completeCallAnalysis(
  context: RepositoryContext,
  input: CompleteCallAnalysisInput,
): Promise<CompleteCallAnalysisOutcome> {
  const row = await lockVersion(context, input.analysisId);
  if (row === 'gone') return { kind: 'gone' };
  if (row.state !== 'pending' || row.origin !== 'model') return { kind: 'not_pending', state: row.state };

  // Both the transcript the request carried and the one stored now, re-read under the lock
  // (review S3A1): a transcript replaced while the model ran fails the version.
  const stored = await readStoredTranscript(context, row.call_session_id);
  if (row.transcript_sha256 !== transcriptSha256(input.utterances) || stored === null || stored.sha256 !== row.transcript_sha256) {
    await writeFailed(context, row.id, 'transcript_changed');
    return { kind: 'failed', analysisId: row.id, reason: 'transcript_changed' };
  }
  const read = readCallAnalysisAnswer(input.rawAnswer, input.utterances);
  if (!read.ok) {
    await writeFailed(context, row.id, read.failure);
    return { kind: 'failed', analysisId: row.id, reason: read.failure };
  }
  // The stored shapes are the contract B and C parse: checked before they are written.
  const result: CallAnalysisResult = callAnalysisResultSchema.parse(read.result);
  const set = proposeEffects(result, input.policyContext);
  const proposals: CallProposal[] = callProposalSetSchema.parse(set.proposals);
  const answeredBy = input.answeredBy?.toLowerCase();
  await context.db.query(
    `UPDATE call_analyses
        SET state = 'completed', result = $3::jsonb, proposals = $4::jsonb, proposal_hash = $5,
            policy_version = $6, completed_at = now(),
            model = coalesce($7, model)
      WHERE workspace_id = $1 AND id = $2 AND state = 'pending'`,
    [
      context.scope.workspaceId,
      row.id,
      JSON.stringify(result),
      JSON.stringify(proposals),
      set.proposalHash,
      set.policyVersion,
      answeredBy !== undefined && /^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(answeredBy) ? answeredBy : null,
    ],
  );
  const dropped = Object.values(result.dropped).reduce((sum, n) => sum + n, 0);
  return { kind: 'completed', analysisId: row.id, version: row.version, proposalHash: set.proposalHash, proposals: proposals.length, dropped };
}

/** Close a pending model version without an answer. A version no longer pending is left alone. */
export async function failCallAnalysis(
  context: RepositoryContext,
  input: { readonly analysisId: string; readonly reason: CallAnalysisFailureReason },
): Promise<CompleteCallAnalysisOutcome> {
  const row = await lockVersion(context, input.analysisId);
  if (row === 'gone') return { kind: 'gone' };
  if (row.state !== 'pending' || row.origin !== 'model') return { kind: 'not_pending', state: row.state };
  await writeFailed(context, row.id, input.reason);
  return { kind: 'failed', analysisId: row.id, reason: input.reason };
}

// ---------------------------------------------------------------------------
// The policy context
// ---------------------------------------------------------------------------

/**
 * The policy's context for one call, read now: when it started, the firm's zone, the
 * contact's name, and whether the firm has an open opportunity. Null for an unknown session.
 */
export async function readPolicyContext(context: RepositoryContext, sessionId: string): Promise<CallPolicyContext | null> {
  const { rows } = await context.db.query<{
    started: Date;
    time_zone: string | null;
    contact_name: string | null;
    open_opportunity: boolean;
  }>(
    `SELECT coalesce(s.answered_at, s.started_at, s.created_at) AS started, f.time_zone, c.full_name AS contact_name,
            EXISTS (SELECT 1 FROM opportunities o
                     WHERE o.workspace_id = s.workspace_id AND o.firm_id = s.firm_id AND o.status = 'open') AS open_opportunity
       FROM call_sessions s
       JOIN firms f ON f.workspace_id = s.workspace_id AND f.id = s.firm_id
       LEFT JOIN contacts c ON c.workspace_id = s.workspace_id AND c.id = s.contact_id
      WHERE s.workspace_id = $1 AND s.id = $2`,
    [context.scope.workspaceId, sessionId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const name = row.contact_name?.replace(/\s+/gu, ' ').trim() ?? '';
  return {
    callStartedAt: row.started.toISOString(),
    firmTimeZone: row.time_zone,
    contactName: name.length === 0 ? null : name,
    hasOpenOpportunity: row.open_opportunity,
  };
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

type VersionRow = {
  readonly id: string;
  readonly version: number;
  readonly origin: CallAnalysisOrigin;
  readonly state: CallAnalysisState;
  readonly requested_reason: CallAnalysisRequestedReason;
  readonly model: string | null;
  readonly transcript_sha256: string | null;
  readonly failure_reason: CallAnalysisFailureReason | null;
  readonly policy_version: string | null;
  readonly result: CallAnalysisResult | null;
  readonly notes: CallAnalysisNotes | null;
  readonly proposals: CallProposal[] | null;
  readonly proposal_hash: string | null;
  readonly created_at: Date;
  readonly completed_at: Date | null;
};

function notesOf(row: VersionRow): CallAnalysisNotes | null {
  if (row.origin === 'user') return row.notes;
  if (row.result === null) return null;
  return { summary: row.result.summary, facts: row.result.facts.map(fact => fact.text) };
}

/**
 * `GET /calls/analysis`: every version of one call's analysis, its current notes and its
 * authoritative model version. Null when the session is unknown or not the caller's firm.
 */
export async function readCallAnalysis(context: RepositoryContext, sessionId: string): Promise<CallAnalysisResponse | null> {
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) return null;
  const { rows: sessions } = await context.db.query<{ firm_id: string }>(
    'SELECT firm_id FROM call_sessions WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, sessionId],
  );
  const firmId = sessions[0]?.firm_id;
  if (firmId === undefined) return null;
  if (context.scope.actor.kind === 'user') {
    const firm = await readFirm(context, firmId);
    if (firm === null || !decideFirmMutation(context, firm).permitted) return null;
  }
  const transcript = await readStoredTranscript(context, sessionId);
  const { rows } = await context.db.query<VersionRow>(
    `SELECT id, version, origin, state, requested_reason, model, transcript_sha256, failure_reason, policy_version,
            result, notes, proposals, proposal_hash, created_at, completed_at
       FROM call_analyses WHERE workspace_id = $1 AND call_session_id = $2
      ORDER BY version DESC`,
    [context.scope.workspaceId, sessionId],
  );
  return callAnalysisResponseOf(sessionId, rows, transcript?.sha256 ?? null);
}

/** The read's rules over the version rows, newest first. Pure. */
export function callAnalysisResponseOf(
  sessionId: string,
  rowsNewestFirst: readonly VersionRow[],
  currentTranscriptSha256: string | null,
): CallAnalysisResponse {
  const completed = rowsNewestFirst.filter(row => row.state === 'completed');
  const currentRow = completed.find(row => row.origin === 'user') ?? completed.find(row => row.origin === 'model') ?? null;
  const currentNotes = currentRow === null ? null : notesOf(currentRow);
  const authoritativeRow =
    currentTranscriptSha256 === null
      ? null
      : (completed.find(row => row.origin === 'model' && row.transcript_sha256 === currentTranscriptSha256) ?? null);
  const pendingRow = rowsNewestFirst.find(row => row.state === 'pending') ?? null;
  const latestModel = rowsNewestFirst.find(row => row.origin === 'model') ?? null;
  return {
    callSessionId: sessionId,
    current:
      currentRow === null || currentNotes === null
        ? null
        : { analysisId: currentRow.id, version: currentRow.version, origin: currentRow.origin, notes: currentNotes },
    notesVersion: currentRow === null || currentNotes === null ? null : currentRow.version,
    authoritative:
      authoritativeRow === null ||
      authoritativeRow.result === null ||
      authoritativeRow.proposals === null ||
      authoritativeRow.proposal_hash === null ||
      authoritativeRow.transcript_sha256 === null ||
      authoritativeRow.policy_version === null
        ? null
        : {
            analysisId: authoritativeRow.id,
            version: authoritativeRow.version,
            transcriptSha256: authoritativeRow.transcript_sha256,
            proposalHash: authoritativeRow.proposal_hash,
            policyVersion: authoritativeRow.policy_version,
            proposals: authoritativeRow.proposals,
            result: authoritativeRow.result,
          },
    pending: pendingRow === null ? null : { analysisId: pendingRow.id, version: pendingRow.version, createdAt: pendingRow.created_at.toISOString() },
    failure:
      latestModel === null || latestModel.state !== 'failed' || latestModel.failure_reason === null
        ? null
        : { analysisId: latestModel.id, version: latestModel.version, reason: latestModel.failure_reason },
    versions: rowsNewestFirst.slice(0, 50).map(row => ({
      analysisId: row.id,
      version: row.version,
      origin: row.origin,
      state: row.state,
      requestedReason: row.requested_reason,
      model: row.model,
      transcriptSha256: row.transcript_sha256,
      failureReason: row.failure_reason,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// The edit command
// ---------------------------------------------------------------------------

export type EditCallAnalysisOutcome =
  | { readonly ok: true; readonly value: CallAnalysisResponse }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_permitted' };

/** `POST /calls/analysis/edit`: David's notes as a new user version, then the read. */
export async function editCallAnalysis(
  context: RepositoryContext,
  input: { readonly sessionId: string; readonly notes: CallAnalysisNotes },
): Promise<EditCallAnalysisOutcome> {
  const created = await createAnalysisVersion(context, { sessionId: input.sessionId, origin: 'user', reason: 'user_edit', notes: input.notes });
  if (created.kind === 'not_permitted') return { ok: false, reason: 'not_permitted' };
  if (created.kind !== 'created') return { ok: false, reason: 'not_found' };
  const read = await readCallAnalysis(context, input.sessionId);
  if (read === null) return { ok: false, reason: 'not_found' };
  return { ok: true, value: read };
}
