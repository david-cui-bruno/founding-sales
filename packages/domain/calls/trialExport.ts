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
 * an e-mail address (written or read out) becomes `[email]`, a web address `[url]`, seven or
 * more digits (as numerals, words or both) `[phone]`, every person the payload knows of (all
 * the firm's contacts, every referral named in a proposal) `[name]`, and the firm's name
 * `[firm]`; a spoken number or a referred person's name in a proposal's params is replaced
 * outright.
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
/** An address read out: "dana at example dot com", best effort. */
const SPOKEN_EMAIL = /\b[\p{L}\p{N}._-]+\s+at\s+[\p{L}\p{N}-]+(?:\s+dot\s+[\p{L}\p{N}-]+)+\b/giu;
/** A web address: a scheme, `www.`, or a dotted host with a common top-level domain. */
const URL_LIKE = /\b(?:https?:\/\/\S+|www\.\S+|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|net|org|io|co|us|biz|info|app|dev|test)(?:\/\S*)?)\b/giu;
/**
 * Seven or more digits of any script (\p{Nd}: ASCII, Arabic-Indic, Devanagari, ...), with any
 * dash (\p{Pd}: the non-breaking hyphen U+2011 and the hyphen U+2010 that NFKC makes of it), any
 * space separator (\p{Zs}) or `.()/` between them (review TERF, finding 2). Over-redaction (a
 * date written with slashes) is accepted.
 */
const PHONE = /\+?\p{Nd}(?:[\s\p{Pd}\p{Zs}.()/]*\p{Nd}){6,}/gu;
/**
 * Seven or more digits spoken as words, alone or mixed with numerals ("four one zero five five
 * five oh one four two", "401 five five five 0142"), best effort: a run of digit words and digit
 * groups, separated by spaces, hyphens, commas or "and", holding seven digits or more.
 */
const DIGIT_WORD = '(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine|double|triple|\\d+)';
const DIGIT_RUN = new RegExp(`\\b${DIGIT_WORD}(?:(?:[\\s,.-]+|\\s+and\\s+)${DIGIT_WORD})+\\b`, 'giu');
const DIGIT_VALUE: Readonly<Record<string, number>> = Object.freeze({ double: 1, triple: 2 });

function digitsIn(run: string): number {
  let count = 0;
  for (const token of run.toLowerCase().split(/[\s,.-]+/u)) {
    if (token === 'and' || token === '') continue;
    if (/^\d+$/u.test(token)) count += token.length;
    else count += DIGIT_VALUE[token] ?? 1;
  }
  return count;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * The canonical form every free-text string is redacted in, and exported as (TE design reset,
 * R3): NFKC (fullwidth digits and letters become ASCII), then every format character (\p{Cf}:
 * zero-width space and joiner, bidi marks and overrides, the BOM) and every other default-ignorable
 * code point removed, then whitespace collapsed. Names are matched in this form on both sides.
 */
export function canonicalText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

const tokensOf = (name: string): string[] =>
  name
    .split(/\s+/u)
    .map(token => token.replace(/[^\p{L}\p{M}'-]/gu, ''))
    .filter(token => token.length >= 2);

/**
 * The redaction every free-text string goes through, on its canonical form (`canonicalText`),
 * which is what it returns. `people` is every person the payload
 * knows of: every contact at the firm and every name in a proposal's params (a referral); each
 * full name, then each of its words, becomes `[name]`. The firm's name becomes `[firm]`.
 */
export function redactorFor(names: { readonly people: readonly (string | null)[]; readonly firm: string | null }): (text: string) => string {
  const firm = canonicalText(names.firm ?? '');
  const people = names.people.map(name => canonicalText(name ?? '')).filter(name => name.length >= 2);
  const phrases = [...new Set(people.filter(name => /\s/u.test(name)))].sort((left, right) => right.length - left.length);
  const tokens = [...new Set(people.flatMap(tokensOf))].sort((left, right) => right.length - left.length);
  const bounded = (alternatives: readonly string[]): RegExp | null =>
    alternatives.length === 0 ? null : new RegExp(`(?<![\\p{L}])(?:${alternatives.map(escape).join('|')})(?![\\p{L}])`, 'giu');
  const firmPattern = firm.length >= 2 ? new RegExp(escape(firm), 'giu') : null;
  const phrasePattern = bounded(phrases);
  const tokenPattern = bounded(tokens);
  return (text: string): string => {
    let out = canonicalText(text).replace(EMAIL, '[email]').replace(SPOKEN_EMAIL, '[email]').replace(URL_LIKE, '[url]').replace(PHONE, '[phone]');
    out = out.replace(DIGIT_RUN, run => (digitsIn(run) >= 7 ? '[phone]' : run));
    if (firmPattern !== null) out = out.replace(firmPattern, '[firm]');
    if (phrasePattern !== null) out = out.replace(phrasePattern, '[name]');
    if (tokenPattern !== null) out = out.replace(tokenPattern, '[name]');
    return out;
  };
}

/** Every person's name a proposal's params carry (a referral's `name`). */
function namesInProposals(proposals: readonly CallProposal[]): string[] {
  const found: string[] = [];
  for (const proposal of proposals) {
    const params = proposal.params as Record<string, unknown>;
    if (typeof params['name'] === 'string') found.push(params['name']);
  }
  return found;
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
    // Every person this call's payload knows: the firm's contacts, and the names its proposals carry.
    const { rows: contacts } = await context.db.query<{ full_name: string | null }>(
      'SELECT full_name FROM contacts WHERE workspace_id = $1 AND firm_id = $2',
      [workspaceId, session.firm_id],
    );
    const redact = redactorFor({
      people: [session.contact_name, ...contacts.map(row => row.full_name), ...namesInProposals(analysis.proposals ?? [])],
      firm: session.firm_name,
    });

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
