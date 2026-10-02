import {
  ACCEPTANCE_MINIMUM_DECIDED,
  CALL_ANALYSIS_EXCLUSION_REASONS,
  CALL_ANALYSIS_FAILURE_REASONS,
  CALL_ANALYSIS_MINIMUM_RECORDING_SECONDS,
  CALL_ANALYSIS_PENDING_SOURCE,
  CALL_PROPOSAL_CORRECTED_ACTION,
  CALL_TRIAL_DEFAULT_SINCE,
  CALL_TRIAL_TARGET_CALLS,
  transcriptIsChannelLabelled,
  type CallAnalysisExclusionReason,
  type CallAnalysisFailureReason,
  type CallProposal,
  type CallProposalDecision,
  type CallTrialResponse,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { callAnalysisEligibility, callWasAnswered, type CallAnalysisFacts } from './analysisEligibility.ts';
import { CALL_ANALYSIS_SUBJECT_KIND, postCallModelPath } from './analysisPaid.ts';
import { PROPOSAL_DECIDED_ACTION, acceptanceTypeOf, authoritativeAnalysis } from './proposalMeasure.ts';
import { TRANSCRIPTION_MAX_ATTEMPTS, TRANSCRIPTION_SUBJECT_KIND } from './transcription.ts';

/**
 * `GET /calls/trial?since=` (slice S3T): the 10-call shadow trial, read from what is stored.
 * No table, no job, nothing written.
 *
 * The calls are the placed calls (consumed sessions) that occurred since `since`, by
 * `coalesce(answered_at, started_at, created_at)` as the recap counts them. A salesperson is
 * read their own firms' calls, an administrator the workspace's (`readDailyRecap`).
 *
 *   * **progress** — answered calls; how many of them the analysis path takes
 *     (`callAnalysisEligibility`); how many of those have a completed model analysis (the
 *     checkpoint counts these toward ten); how many have every suggestion decided;
 *   * **unanswered** — by the provider's status, apart from the answered-but-excluded;
 *   * **excluded** — every answered call the rule excludes, by reason and listed, so none
 *     disappears from the assessment;
 *   * **analysis** — for the eligible calls: completed, failed (by reason), pending, held;
 *   * **heldButExcluded** — the check line: calls held for review that the rule excludes;
 *   * **types** — the acceptance read's per-type counts, over these calls only, with how many
 *     suggestions of each type were offered to apply and one such suggestion, so the desktop
 *     can mark the types that start ticked with its own rule;
 *   * **incorrect** — every stop or deal-opening suggestion on these calls David declined or
 *     edited, by id.
 *
 * Corrections (the outcome-correction slice, S3X, later): a separate audit action,
 * `call.proposal_corrected`, `{analysisId, key, reason: original_error | new_information,
 * priorResult, before, after}`; the decision row is never rewritten. `unchanged` stays the
 * initial acceptance; `correctedOriginalError` and `correctedNewInformation` count the
 * distinct (analysis, key) pairs with such a row (`original_error` if any row says so); the
 * bar's share is (unchanged − those unchanged pairs corrected for an original error) /
 * decided; and a stop or deal suggestion corrected for an original error is incorrect.
 */

type SessionRow = {
  readonly id: string;
  readonly firm_id: string;
  readonly firm_name: string;
  readonly occurred_at: Date;
  readonly status: string;
  readonly provider_status: string | null;
  readonly answered: boolean;
  readonly recording: boolean;
  readonly recording_seconds: number | null;
  readonly call_seconds: number | null;
  readonly transcript_provider: string | null;
  readonly transcript_model: string | null;
  readonly transcribe_jobs: number;
  readonly transcribe_open: boolean;
  readonly provider_job_failed: boolean;
  readonly transcription_spent: number;
  readonly transcription_open_reservation: boolean;
  readonly on_when_recorded: boolean | null;
  readonly ever_held: boolean;
};

type VersionRow = {
  readonly call_session_id: string;
  readonly id: string;
  readonly state: 'pending' | 'completed' | 'failed';
  readonly failure_reason: string | null;
  readonly open_job: boolean;
  readonly open_reservation: boolean;
};

type DecisionRow = {
  readonly analysis_id: string;
  readonly call_session_id: string;
  readonly key: string;
  readonly type: string;
  readonly result: CallProposalDecision;
  readonly occurred_at: Date;
};

/** The session facts the rule reads, from one session row. */
function factsOf(row: SessionRow, summaryPath: boolean): CallAnalysisFacts {
  const transcript =
    row.transcript_provider === null || row.transcript_model === null
      ? ('none' as const)
      : transcriptIsChannelLabelled({ provider: row.transcript_provider, model: row.transcript_model })
        ? ('channel_labelled' as const)
        : ('not_channel_labelled' as const);
  const transcribeQueued = Number(row.transcribe_jobs) > 0;
  return {
    status: row.status,
    providerStatus: row.provider_status,
    answered: row.answered,
    recording: row.recording,
    recordingSeconds: row.recording_seconds === null ? null : Number(row.recording_seconds),
    // Was transcription on when the call was recorded? A queued transcription or a stored
    // transcript says yes; otherwise the setting's version in effect when the call ended.
    transcriptionOn: transcript !== 'none' || transcribeQueued || row.on_when_recorded === true,
    transcript,
    transcribeQueued,
    transcriptionFailed:
      transcript === 'none' &&
      (row.provider_job_failed ||
        (!row.transcribe_open && !row.transcription_open_reservation && Number(row.transcription_spent) >= TRANSCRIPTION_MAX_ATTEMPTS)),
    summaryPath,
  };
}

const byReasonOrder = (reason: CallAnalysisExclusionReason): number => CALL_ANALYSIS_EXCLUSION_REASONS.indexOf(reason);

export async function readCallTrial(context: RepositoryContext, options: { readonly since?: string | undefined } = {}): Promise<CallTrialResponse> {
  const since = new Date(options.since ?? CALL_TRIAL_DEFAULT_SINCE).toISOString();
  const workspaceId = context.scope.workspaceId;
  const actor = context.scope.actor;
  const assignedUserId = actor.kind === 'user' && actor.role !== 'admin' ? actor.userId : null;

  const { rows: sessions } = await context.db.query<SessionRow>(
    `SELECT s.id, s.firm_id, f.name AS firm_name, coalesce(s.answered_at, s.started_at, s.created_at) AS occurred_at,
            s.status, s.provider_status, s.answered_at IS NOT NULL AS answered,
            s.recording_path IS NOT NULL AS recording, s.recording_duration_seconds AS recording_seconds,
            s.duration_seconds AS call_seconds,
            t.provider AS transcript_provider, t.model AS transcript_model,
            (SELECT count(*) FROM jobs j WHERE j.workspace_id = s.workspace_id AND j.kind = 'call.transcribe'
                AND j.payload ->> 'callSessionId' = s.id::text)::integer AS transcribe_jobs,
            EXISTS (SELECT 1 FROM jobs j WHERE j.workspace_id = s.workspace_id AND j.kind = 'call.transcribe'
                AND j.payload ->> 'callSessionId' = s.id::text AND j.state IN ('queued', 'running', 'retryable')) AS transcribe_open,
            EXISTS (SELECT 1 FROM transcription_provider_jobs pj
                     WHERE pj.workspace_id = s.workspace_id AND pj.call_session_id = s.id AND pj.state = 'failed') AS provider_job_failed,
            (SELECT count(*) FROM provider_reservations r WHERE r.workspace_id = s.workspace_id AND r.subject_kind = $4
                AND r.subject_id = s.id AND r.state <> 'released')::integer AS transcription_spent,
            EXISTS (SELECT 1 FROM provider_reservations r WHERE r.workspace_id = s.workspace_id AND r.subject_kind = $4
                AND r.subject_id = s.id AND r.state IN ('reserved', 'calling')) AS transcription_open_reservation,
            (SELECT (w.value ->> 'enabled')::boolean AND (w.value ->> 'dailyCeilingCents')::integer > 0
               FROM workspace_settings w
              WHERE w.workspace_id = s.workspace_id AND w.setting_key = 'call_transcription'
                AND w.changed_at <= coalesce(s.ended_at, s.updated_at)
              ORDER BY w.version DESC LIMIT 1) AS on_when_recorded,
            EXISTS (SELECT 1 FROM active_holds h WHERE h.workspace_id = s.workspace_id AND h.source_event_kind = $5
                     AND h.source_event_id = s.id::text) AS ever_held
       FROM call_sessions s
       JOIN firms f ON f.workspace_id = s.workspace_id AND f.id = s.firm_id
       LEFT JOIN call_transcripts t ON t.workspace_id = s.workspace_id AND t.call_session_id = s.id
      WHERE s.workspace_id = $1 AND s.consumed_at IS NOT NULL
        AND coalesce(s.answered_at, s.started_at, s.created_at) >= $2::timestamptz
        AND ($3::uuid IS NULL OR f.assigned_user_id = $3::uuid)
      ORDER BY coalesce(s.answered_at, s.started_at, s.created_at) DESC, s.id`,
    [workspaceId, since, assignedUserId, TRANSCRIPTION_SUBJECT_KIND, CALL_ANALYSIS_PENDING_SOURCE],
  );
  const sessionIds = sessions.map(row => row.id);

  const { rows: versions } = await context.db.query<VersionRow>(
    `SELECT DISTINCT ON (a.call_session_id) a.call_session_id, a.id, a.state, a.failure_reason,
            EXISTS (SELECT 1 FROM jobs j WHERE j.workspace_id = a.workspace_id AND j.kind IN ('call.analyze', 'call.analyze_sweep')
                     AND j.payload ->> 'callSessionId' = a.call_session_id::text AND j.state IN ('queued', 'running', 'retryable')) AS open_job,
            EXISTS (SELECT 1 FROM provider_reservations r WHERE r.workspace_id = a.workspace_id AND r.subject_kind = $3
                     AND r.subject_id = a.id AND r.state IN ('reserved', 'calling')) AS open_reservation
       FROM call_analyses a
      WHERE a.workspace_id = $1 AND a.call_session_id = ANY($2::uuid[]) AND a.origin = 'model'
      ORDER BY a.call_session_id, a.version DESC`,
    [workspaceId, sessionIds, CALL_ANALYSIS_SUBJECT_KIND],
  );
  const latestVersion = new Map(versions.map(row => [row.call_session_id, row] as const));
  const { rows: analyseJobs } = await context.db.query<{ session_id: string; open: boolean }>(
    `SELECT j.payload ->> 'callSessionId' AS session_id, bool_or(j.state IN ('queued', 'running', 'retryable')) AS open
       FROM jobs j WHERE j.workspace_id = $1 AND j.kind = 'call.analyze' AND j.payload ->> 'callSessionId' = ANY($2::text[])
      GROUP BY 1`,
    [workspaceId, sessionIds],
  );
  const analyseJobOf = new Map(analyseJobs.map(row => [row.session_id, row.open] as const));

  // The latest decision per (analysis, key), on these calls only.
  const { rows: decisions } = await context.db.query<DecisionRow>(
    `SELECT DISTINCT ON (detail->>'analysisId', detail->>'key')
            detail->>'analysisId' AS analysis_id, detail->>'callSessionId' AS call_session_id,
            detail->>'key' AS key, detail->>'type' AS type, detail->>'result' AS result, occurred_at
       FROM audit_events
      WHERE workspace_id = $1 AND action = $2 AND detail->>'callSessionId' = ANY($3::text[])
      ORDER BY detail->>'analysisId', detail->>'key', occurred_at DESC, id DESC`,
    [workspaceId, PROPOSAL_DECIDED_ACTION, sessionIds],
  );
  const pairOf = (analysisId: string, key: string): string => `${analysisId}\u0000${key}`;
  const decisionOf = new Map(decisions.map(row => [pairOf(row.analysis_id, row.key), row] as const));
  const decided = new Set(decisionOf.keys());

  // Corrections (the outcome-correction slice, S3X): a separate action, never a rewrite of the
  // decision row, so the counts above stay intact. One pair counts once: `original_error` if
  // any of its rows says so, else `new_information`. Only a pair with a decision here counts.
  const { rows: correctionRows } = await context.db.query<{ analysis_id: string; key: string; original_error: boolean; new_information: boolean; at: Date }>(
    `SELECT detail->>'analysisId' AS analysis_id, detail->>'key' AS key,
            bool_or(detail->>'reason' = 'original_error') AS original_error,
            bool_or(detail->>'reason' = 'new_information') AS new_information,
            max(occurred_at) FILTER (WHERE detail->>'reason' = 'original_error') AS at
       FROM audit_events
      WHERE workspace_id = $1 AND action = $2 AND detail->>'analysisId' = ANY($3::text[])
      GROUP BY 1, 2`,
    [workspaceId, CALL_PROPOSAL_CORRECTED_ACTION, [...new Set(decisions.map(row => row.analysis_id))]],
  );
  const correctedOf = new Map<string, { originalError: number; originalErrorAmongUnchanged: number; newInformation: number }>();
  const correctedIncorrect: { readonly decision: DecisionRow; readonly at: Date }[] = [];
  for (const row of correctionRows) {
    const decision = decisionOf.get(pairOf(row.analysis_id, row.key));
    if (decision === undefined) continue;
    const entry = correctedOf.get(decision.type) ?? { originalError: 0, originalErrorAmongUnchanged: 0, newInformation: 0 };
    if (row.original_error) {
      entry.originalError += 1;
      if (decision.result === 'unchanged') entry.originalErrorAmongUnchanged += 1;
      correctedIncorrect.push({ decision, at: row.at });
    } else if (row.new_information) {
      entry.newInformation += 1;
    }
    correctedOf.set(decision.type, entry);
  }

  let answered = 0;
  let eligible = 0;
  let analysed = 0;
  let fullyDecided = 0;
  let heldButExcluded = 0;
  const unanswered = new Map<string, number>();
  const excludedCounts = new Map<CallAnalysisExclusionReason, number>();
  const excludedSessions: CallTrialResponse['excluded']['sessions'][number][] = [];
  const outcome = { completed: 0, failed: 0, pending: 0, held: 0 };
  const failedByReason = new Map<CallAnalysisFailureReason, number>();
  const undecided = new Map<string, number>();
  const modes = new Map<string, { apply: number; review: number; sample: CallProposal | null }>();

  for (const row of sessions) {
    const summaryPath = (await postCallModelPath(context.db, workspaceId, row.id)) === 'summary';
    const facts = factsOf(row, summaryPath);
    const verdict = callAnalysisEligibility(facts);
    if (!callWasAnswered(facts)) {
      const status = row.provider_status ?? 'none';
      unanswered.set(status, (unanswered.get(status) ?? 0) + 1);
      if (row.ever_held && verdict.kind === 'excluded') heldButExcluded += 1;
      continue;
    }
    answered += 1;
    if (verdict.kind === 'excluded') {
      if (row.ever_held) heldButExcluded += 1;
      excludedCounts.set(verdict.reason, (excludedCounts.get(verdict.reason) ?? 0) + 1);
      excludedSessions.push({
        callSessionId: row.id,
        firmId: row.firm_id,
        firmName: row.firm_name,
        occurredAt: row.occurred_at.toISOString(),
        callSeconds: row.call_seconds === null ? null : Number(row.call_seconds),
        recordingSeconds: verdict.recordingSeconds,
        providerStatus: row.provider_status,
        reason: verdict.reason,
      });
      continue;
    }
    eligible += 1;

    const authoritative = await authoritativeAnalysis(context, row.id);
    if (authoritative !== null) {
      outcome.completed += 1;
      analysed += 1;
      let open = 0;
      for (const proposal of authoritative.proposals) {
        const type = acceptanceTypeOf(proposal);
        const mode = modes.get(type) ?? { apply: 0, review: 0, sample: null };
        if (proposal.mode === 'apply') {
          mode.apply += 1;
          // Sessions are newest first: the first apply-mode suggestion seen is the newest.
          mode.sample ??= proposal;
        } else {
          mode.review += 1;
        }
        modes.set(type, mode);
        if (!decided.has(`${authoritative.id}\u0000${proposal.key}`)) {
          open += 1;
          undecided.set(type, (undecided.get(type) ?? 0) + 1);
        }
      }
      if (open === 0) fullyDecided += 1;
      continue;
    }
    const version = latestVersion.get(row.id);
    if (version?.state === 'failed') {
      outcome.failed += 1;
      const reason = (CALL_ANALYSIS_FAILURE_REASONS as readonly string[]).includes(version.failure_reason ?? '')
        ? (version.failure_reason as CallAnalysisFailureReason)
        : 'provider_error';
      failedByReason.set(reason, (failedByReason.get(reason) ?? 0) + 1);
      continue;
    }
    // Not analysed yet. Moving: a job or a reservation is open, or nothing has been tried yet.
    // Held: everything tried has finished and nothing will move it until a setting changes.
    const moving =
      version !== undefined
        ? version.open_job || version.open_reservation || version.state === 'completed'
        : facts.transcript === 'none'
          ? row.transcribe_open || row.transcription_open_reservation
          : analyseJobOf.get(row.id) !== false;
    if (moving) outcome.pending += 1;
    else outcome.held += 1;
  }

  // Per type, as the acceptance read counts it, over these calls only.
  const counts = new Map<string, { unchanged: number; edited: number; declined: number; bypassed: number }>();
  const bucket = (type: string) => {
    const existing = counts.get(type);
    if (existing !== undefined) return existing;
    const fresh = { unchanged: 0, edited: 0, declined: 0, bypassed: 0 };
    counts.set(type, fresh);
    return fresh;
  };
  for (const row of decisions) bucket(row.type)[row.result] += 1;
  for (const type of undecided.keys()) bucket(type);
  for (const type of modes.keys()) bucket(type);

  const types = [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([type, c]) => {
      const decidedCount = c.unchanged + c.edited + c.declined + c.bypassed;
      const mode = modes.get(type);
      const corrected = correctedOf.get(type) ?? { originalError: 0, originalErrorAmongUnchanged: 0, newInformation: 0 };
      return {
        type,
        ...c,
        undecided: undecided.get(type) ?? 0,
        correctedOriginalError: corrected.originalError,
        correctedNewInformation: corrected.newInformation,
        // The bar's share: an unchanged acceptance later corrected for an original model error
        // is not one.
        acceptedUnchangedShare: decidedCount === 0 ? null : (c.unchanged - corrected.originalErrorAmongUnchanged) / decidedCount,
        insufficient: decidedCount < ACCEPTANCE_MINIMUM_DECIDED,
        applyMode: mode?.apply ?? 0,
        reviewMode: mode?.review ?? 0,
        applySample: mode?.sample ?? null,
      };
    });

  const incorrect = [
    ...decisions
      .filter((row): row is DecisionRow & { result: 'declined' | 'edited' } => row.result === 'declined' || row.result === 'edited')
      .map(row => ({ row, result: row.result, at: row.occurred_at })),
    ...correctedIncorrect.map(entry => ({ row: entry.decision, result: 'corrected' as const, at: entry.at })),
  ]
    .filter(entry => entry.row.type === 'buying_signal' || entry.row.type === 'stop')
    .sort((left, right) => left.at.getTime() - right.at.getTime())
    .map(entry => ({
      analysisId: entry.row.analysis_id,
      callSessionId: entry.row.call_session_id,
      key: entry.row.key,
      type: entry.row.type as 'buying_signal' | 'stop',
      result: entry.result,
      decidedAt: entry.at.toISOString(),
    }));

  return {
    since,
    minimumRecordingSeconds: CALL_ANALYSIS_MINIMUM_RECORDING_SECONDS,
    target: CALL_TRIAL_TARGET_CALLS,
    minimumDecided: ACCEPTANCE_MINIMUM_DECIDED,
    progress: { answered, eligible, analysed, fullyDecided },
    unanswered: {
      total: [...unanswered.values()].reduce((sum, n) => sum + n, 0),
      byProviderStatus: [...unanswered.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([providerStatus, n]) => ({ providerStatus, count: n })),
    },
    excluded: {
      byReason: [...excludedCounts.entries()].sort(([a], [b]) => byReasonOrder(a) - byReasonOrder(b)).map(([reason, n]) => ({ reason, count: n })),
      sessions: excludedSessions,
    },
    analysis: {
      ...outcome,
      failedByReason: [...failedByReason.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, n]) => ({ reason, count: n })),
    },
    heldButExcluded,
    types,
    incorrect,
  };
}
