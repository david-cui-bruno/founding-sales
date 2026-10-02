import { CALL_PROPOSAL_CORRECTED_ACTION, transcriptIsChannelLabelled, transcriptSpeakerLabels, type CallProposal, type CallTranscriptUtterance } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { PROPOSAL_DECIDED_ACTION } from './proposalMeasure.ts';
import { computeCallTrial } from './trialReport.ts';

/**
 * The trial export's plaintext (slice S3T-E; David's approval of 2 October 2026): the calls
 * `GET /calls/trial` counts toward ten, oldest first, each with what a reviewer needs to judge
 * the suggestions and nothing else.
 *
 *   * the call: session, firm and contact ids, when, how long;
 *   * the transcript, speaker-labelled;
 *   * the authoritative analysis: its proposals with keys, kinds, modes, params and evidence;
 *   * every decision (`call.proposal_decided`) and correction (`call.proposal_corrected`);
 *   * the logged outcome.
 *
 * Never: audio, a recording path, a number, an address, a contact's name, a log's note. Ids
 * stand in for people. In every free-text string (the transcript, quotes, reasons, task text)
 * an e-mail address becomes `[email]`, a run of seven or more digits `[phone]`, the call's
 * contact's name `[contact]` and the firm's name `[firm]`; a spoken number or a referred
 * person's name in a proposal's params is replaced outright.
 *
 * It is built in memory only, inside the caller's READ ONLY transaction, and is encrypted by
 * the caller (`fss admin trial export`) before anything leaves the process.
 */

export const TRIAL_EXPORT_FORMAT = 'fss.trial-export.v1';

export interface TrialExportCall {
  readonly callSessionId: string;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly occurredAt: string;
  readonly callSeconds: number | null;
  readonly recordingSeconds: number | null;
  readonly transcript: {
    readonly channelLabelled: boolean;
    readonly turns: readonly { readonly line: number; readonly speaker: string; readonly start: number; readonly end: number; readonly text: string }[];
  };
  readonly analysis: {
    readonly analysisId: string;
    readonly version: number;
    readonly model: string | null;
    readonly promptVersion: string | null;
    readonly policyVersion: string | null;
    readonly proposalHash: string | null;
    readonly proposals: readonly CallProposal[];
  };
  readonly decisions: readonly { readonly analysisId: string; readonly key: string; readonly type: string | null; readonly result: string; readonly at: string }[];
  readonly corrections: readonly {
    readonly analysisId: string;
    readonly key: string;
    readonly reason: string | null;
    readonly priorResult: string | null;
    readonly from: unknown;
    readonly to: unknown;
    readonly at: string;
  }[];
  readonly loggedOutcome: { readonly outcome: string; readonly occurredAt: string } | null;
}

export interface TrialExportPayload {
  readonly format: typeof TRIAL_EXPORT_FORMAT;
  readonly workspaceId: string;
  readonly since: string;
  readonly calls: readonly TrialExportCall[];
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/giu;
/** Seven or more digits, with the separators people write numbers with. */
const PHONE = /\+?\d(?:[\s().-]*\d){6,}/gu;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The redaction every free-text string goes through. */
export function redactorFor(names: { readonly contact: string | null; readonly firm: string | null }): (text: string) => string {
  const firm = names.firm?.trim() ?? '';
  const contactTokens = (names.contact ?? '')
    .split(/\s+/u)
    .map(token => token.replace(/[^\p{L}\p{M}'-]/gu, ''))
    .filter(token => token.length >= 2)
    .sort((left, right) => right.length - left.length);
  const firmPattern = firm.length >= 2 ? new RegExp(escape(firm), 'giu') : null;
  const contactPattern = contactTokens.length > 0 ? new RegExp(`(?<![\\p{L}])(?:${contactTokens.map(escape).join('|')})(?![\\p{L}])`, 'giu') : null;
  return (text: string): string => {
    let out = text.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
    if (firmPattern !== null) out = out.replace(firmPattern, '[firm]');
    if (contactPattern !== null) out = out.replace(contactPattern, '[contact]');
    return out;
  };
}

/** Free-text params; every other string param is a code, a date or a zone. */
const FREE_TEXT_PARAMS: ReadonlySet<string> = new Set(['text', 'quote', 'duePhrase', 'phrase', 'role']);
/** Params that are a person or a number outright. */
const REPLACED_PARAMS: Readonly<Record<string, string>> = Object.freeze({ spokenNumber: '[phone]', name: '[name]' });

export function redactProposal(proposal: CallProposal, redact: (text: string) => string): CallProposal {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(proposal.params as Record<string, unknown>)) {
    if (key in REPLACED_PARAMS) params[key] = REPLACED_PARAMS[key];
    else if (key === 'evidence' && Array.isArray(value)) {
      params[key] = value.map(ref => {
        const quoted = ref as Record<string, unknown>;
        return { ...quoted, quote: typeof quoted['quote'] === 'string' ? redact(quoted['quote']) : quoted['quote'] };
      });
    } else if (FREE_TEXT_PARAMS.has(key) && typeof value === 'string') params[key] = redact(value);
    else params[key] = value;
  }
  return { ...proposal, reason: redact(proposal.reason), params } as CallProposal;
}

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * The plaintext of one workspace's export: the trial's analysed calls since `since`, oldest
 * first, at most `maxCalls`. Reads only.
 */
export async function buildTrialExport(
  context: RepositoryContext,
  options: { readonly since?: string | undefined; readonly maxCalls: number },
): Promise<TrialExportPayload> {
  const workspaceId = context.scope.workspaceId;
  const { response, analysedCalls } = await computeCallTrial(context, { since: options.since });
  const calls: TrialExportCall[] = [];
  for (const selected of analysedCalls.slice(0, Math.max(0, options.maxCalls))) {
    const { rows: sessions } = await context.db.query<{
      firm_id: string;
      contact_id: string | null;
      call_seconds: number | null;
      recording_seconds: number | null;
      call_log_id: string | null;
      contact_name: string | null;
      firm_name: string | null;
    }>(
      `SELECT s.firm_id, s.contact_id, s.duration_seconds AS call_seconds, s.recording_duration_seconds AS recording_seconds,
              s.call_log_id, c.full_name AS contact_name, f.name AS firm_name
         FROM call_sessions s
         JOIN firms f ON f.workspace_id = s.workspace_id AND f.id = s.firm_id
         LEFT JOIN contacts c ON c.workspace_id = s.workspace_id AND c.id = s.contact_id
        WHERE s.workspace_id = $1 AND s.id = $2`,
      [workspaceId, selected.callSessionId],
    );
    const session = sessions[0];
    if (session === undefined) continue;
    const redact = redactorFor({ contact: session.contact_name, firm: session.firm_name });

    const { rows: transcripts } = await context.db.query<{ provider: string; model: string; utterances: unknown }>(
      'SELECT provider, model, utterances FROM call_transcripts WHERE workspace_id = $1 AND call_session_id = $2',
      [workspaceId, selected.callSessionId],
    );
    const transcript = transcripts[0];
    const utterances = Array.isArray(transcript?.utterances) ? (transcript.utterances as CallTranscriptUtterance[]) : [];
    const channelLabelled = transcript === undefined ? false : transcriptIsChannelLabelled(transcript);
    const labels = transcriptSpeakerLabels(utterances, { channelLabelled });

    const { rows: analyses } = await context.db.query<{
      version: number;
      model: string | null;
      prompt_version: string | null;
      policy_version: string | null;
      proposal_hash: string | null;
      proposals: CallProposal[] | null;
    }>(
      `SELECT version, model, prompt_version, policy_version, proposal_hash, proposals
         FROM call_analyses WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, selected.analysisId],
    );
    const analysis = analyses[0];
    if (analysis === undefined) continue;

    const { rows: decided } = await context.db.query<{ analysis_id: string; key: string; type: string | null; result: string; at: Date }>(
      `SELECT detail->>'analysisId' AS analysis_id, detail->>'key' AS key, detail->>'type' AS type, detail->>'result' AS result,
              occurred_at AS at
         FROM audit_events
        WHERE workspace_id = $1 AND action = $2 AND detail->>'callSessionId' = $3
        ORDER BY occurred_at, id`,
      [workspaceId, PROPOSAL_DECIDED_ACTION, selected.callSessionId],
    );
    const analysisIds = [...new Set([selected.analysisId, ...decided.map(row => row.analysis_id)])];
    const { rows: corrected } = await context.db.query<{
      analysis_id: string;
      key: string;
      reason: string | null;
      prior: string | null;
      before: unknown;
      after: unknown;
      at: Date;
    }>(
      `SELECT detail->>'analysisId' AS analysis_id, detail->>'key' AS key, detail->>'reason' AS reason,
              detail->>'priorResult' AS prior, coalesce(detail->'correctedFrom', detail->'before') AS before,
              coalesce(detail->'correctedTo', detail->'after') AS after, occurred_at AS at
         FROM audit_events
        WHERE workspace_id = $1 AND action = $2 AND detail->>'analysisId' = ANY($3::text[])
        ORDER BY occurred_at, id`,
      [workspaceId, CALL_PROPOSAL_CORRECTED_ACTION, analysisIds],
    );
    const { rows: logs } = await context.db.query<{ outcome: string; occurred_at: Date }>(
      'SELECT outcome, occurred_at FROM call_logs WHERE workspace_id = $1 AND id = $2',
      [workspaceId, session.call_log_id],
    );
    const logged = logs[0];

    calls.push({
      callSessionId: selected.callSessionId,
      firmId: session.firm_id,
      contactId: session.contact_id,
      occurredAt: selected.occurredAt,
      callSeconds: session.call_seconds === null ? null : Number(session.call_seconds),
      recordingSeconds: session.recording_seconds === null ? null : Number(session.recording_seconds),
      transcript: {
        channelLabelled,
        turns: utterances.map((utterance, index) => ({
          line: index + 1,
          speaker: labels.get(utterance.speaker) ?? `Speaker ${String(utterance.speaker + 1)}`,
          start: utterance.start,
          end: utterance.end,
          text: redact(utterance.text),
        })),
      },
      analysis: {
        analysisId: selected.analysisId,
        version: analysis.version,
        model: analysis.model,
        promptVersion: analysis.prompt_version,
        policyVersion: analysis.policy_version,
        proposalHash: analysis.proposal_hash,
        proposals: (analysis.proposals ?? []).map(proposal => redactProposal(proposal, redact)),
      },
      decisions: decided.map(row => ({ analysisId: row.analysis_id, key: row.key, type: row.type, result: row.result, at: iso(row.at) })),
      // S3X writes `correctedFrom`/`correctedTo` (outcome codes, effect ids, `undone`); the
      // `before`/`after` of the S3X design are read too. Codes and ids only, kept as they are.
      corrections: corrected.map(row => ({
        analysisId: row.analysis_id,
        key: row.key,
        reason: row.reason,
        priorResult: row.prior,
        from: row.before,
        to: row.after,
        at: iso(row.at),
      })),
      loggedOutcome: logged === undefined ? null : { outcome: logged.outcome, occurredAt: iso(logged.occurred_at) },
    });
  }
  return { format: TRIAL_EXPORT_FORMAT, workspaceId, since: response.since, calls };
}
