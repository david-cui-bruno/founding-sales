// The trial review's logic (slice S3T-E), shared by decrypt.mjs and review.mjs and tested with a
// stubbed Bedrock client (test/ops/trialReview.check.ts). Runs on David's Mac, never in the app.
//
// Nothing here prints transcript text. The only things that leave this module on stdout are ids,
// kinds, verdicts, categories, the model's reasons (checked for quotes) and cost estimates.

import { constants, createDecipheriv, privateDecrypt } from 'node:crypto';

export const EXPORT_ALG = 'RSA-OAEP-256+A256GCM';

/**
 * Claude Sonnet 4.6 on Amazon Bedrock, through its US geo cross-region inference profile, from
 * us-east-1. Source: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html
 * (model ID `anthropic.claude-sonnet-4-6`, geo inference ID `us.anthropic.claude-sonnet-4-6`,
 * Invoke API on bedrock-runtime, structured outputs supported; read 2 October 2026).
 */
export const REVIEW_MODEL = Object.freeze({
  inferenceProfileId: 'us.anthropic.claude-sonnet-4-6',
  foundationModelId: 'anthropic.claude-sonnet-4-6',
  region: 'us-east-1',
  profile: 'default',
});

/**
 * Bedrock's on-demand price for Claude Sonnet 4.6, in US dollars per million tokens, for the
 * geo (`us.*`) profile: the global rate of $3.00 input / $15.00 output
 * (https://aws.amazon.com/bedrock/pricing/, Anthropic, Claude Sonnet 4.6) plus the 10% regional
 * premium the AWS Price List shows for geo profiles (as `packages/domain/classification/
 * modelTransport.ts` records for Haiku 4.5, Opus 5 and Sonnet 5.5). The higher of the two, so
 * the cap holds whichever applies.
 */
export const REVIEW_PRICE = Object.freeze({ inputUsdPerMillion: 3.3, outputUsdPerMillion: 16.5 });

/** The most one review answer may be. */
export const REVIEW_MAX_OUTPUT_TOKENS = 4_000;
export const REVIEW_DEFAULT_CAP_USD = 3;
export const REVIEW_REASON_MAX_CHARS = 200;
/** A run of this many words of the transcript, anywhere in the output, fails the run. */
export const QUOTE_RUN_WORDS = 8;

// ---------------------------------------------------------------------------
// The export: lines, parts, the envelope
// ---------------------------------------------------------------------------

/**
 * Every export part in a text: one JSON object per line, as `fss admin trial export` printed it,
 * wherever it sits in the line (the ops helper indents the task's log lines). Grouped by export,
 * and refused unless exactly one export is complete.
 */
export function readExportParts(text) {
  const byExport = new Map();
  for (const raw of text.split(/\r?\n/u)) {
    const start = raw.indexOf('{');
    if (start < 0) continue;
    let value;
    try {
      value = JSON.parse(raw.slice(start).trim());
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || value.v !== 1 || value.alg !== EXPORT_ALG) continue;
    const parts = byExport.get(value.exportId) ?? new Map();
    parts.set(value.part, value);
    byExport.set(value.exportId, parts);
  }
  const complete = [...byExport.values()].filter(parts => {
    const first = parts.get(1);
    if (first === undefined) return false;
    for (let index = 1; index <= first.of; index += 1) if (!parts.has(index)) return false;
    return true;
  });
  if (complete.length === 0) throw new Error('no complete trial export in this file');
  if (complete.length > 1) throw new Error('more than one complete trial export in this file; keep only the one to decrypt');
  const parts = complete[0];
  const first = parts.get(1);
  return [...Array(first.of).keys()].map(index => parts.get(index + 1));
}

/** The plaintext JSON of an export, with the private key (a KeyObject). */
export function decryptExport(parts, privateKey) {
  const first = parts[0];
  if (first === undefined || typeof first.wrappedKey !== 'string' || typeof first.iv !== 'string' || typeof first.tag !== 'string') {
    throw new Error('the first part carries no key');
  }
  const contentKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(first.wrappedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(first.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(first.tag, 'base64'));
  const ciphertext = Buffer.from(parts.map(part => part.ciphertext).join(''), 'base64');
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  contentKey.fill(0);
  return JSON.parse(plaintext.toString('utf8'));
}

/** The calls of a decrypted export, every workspace's, in order. */
export function callsOf(exported) {
  if (exported === null || typeof exported !== 'object' || !Array.isArray(exported.workspaces)) throw new Error('not a trial export');
  return exported.workspaces.flatMap(workspace => (Array.isArray(workspace.calls) ? workspace.calls : []));
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export const REVIEW_SYSTEM = [
  'You review the suggestions an assistant made after a sales call, against the call transcript.',
  'You are given the transcript (numbered lines, "You" is the caller, "Them" is the prospect), every suggestion with its evidence lines,',
  "the caller's decision on each suggestion (unchanged, edited, declined, bypassed; or none), any later correction, and the outcome he logged.",
  'For EVERY suggestion, by its key:',
  '- verdict: "correct" if the transcript supports it as proposed, "incorrect" if it does not, "unclear" if the transcript cannot tell;',
  '- category, only when incorrect: "false_positive" (nothing in the call called for it), "wrong_value" (right kind, wrong value such as the outcome, time or scope), or "missed_context" (something later or elsewhere in the call changes it); otherwise null;',
  '- reason: at most 200 characters, in your own words. NEVER quote, copy or closely paraphrase the transcript; refer to lines by number instead (for example "line 7 declines the demo").',
  '- decisionMatchesEvidence: "yes" if the caller\'s decision fits the transcript, "no" if it does not, "unclear", or "no_decision" when he made none.',
  'Answer only with the JSON the schema describes, one entry per suggestion key, each key exactly once.',
].join('\n');

/** The answer's schema (structured outputs: closed objects, every property required). */
export const VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'verdict', 'category', 'reason', 'decisionMatchesEvidence'],
        properties: {
          key: { type: 'string' },
          verdict: { type: 'string', enum: ['correct', 'incorrect', 'unclear'] },
          category: { anyOf: [{ type: 'string', enum: ['false_positive', 'wrong_value', 'missed_context'] }, { type: 'null' }] },
          reason: { type: 'string' },
          decisionMatchesEvidence: { type: 'string', enum: ['yes', 'no', 'unclear', 'no_decision'] },
        },
      },
    },
  },
});

/** What the model reads of one call: the transcript, the suggestions, the decisions, the outcome. */
export function reviewInputOf(call) {
  const latest = new Map();
  for (const decision of call.decisions ?? []) if (decision.analysisId === call.analysis.analysisId) latest.set(decision.key, decision.result);
  return {
    transcript: (call.transcript?.turns ?? []).map(turn => ({ line: turn.line, speaker: turn.speaker, text: turn.text })),
    suggestions: (call.analysis?.proposals ?? []).map(proposal => ({
      key: proposal.key,
      kind: proposal.kind,
      mode: proposal.mode,
      reason: proposal.reason,
      params: proposal.params,
      decision: latest.get(proposal.key) ?? null,
    })),
    corrections: (call.corrections ?? []).map(correction => ({ key: correction.key, reason: correction.reason, from: correction.from, to: correction.to })),
    loggedOutcome: call.loggedOutcome?.outcome ?? null,
  };
}

/** The InvokeModel body for one call. */
export function reviewRequestOf(call) {
  return {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: REVIEW_MAX_OUTPUT_TOKENS,
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(reviewInputOf(call)) }],
    output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
  };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/** An upper bound on the input tokens: no tokenizer yields more than one token per 3 UTF-8 bytes of JSON text here. */
export function inputTokenBound(body) {
  return Math.ceil(Buffer.byteLength(body, 'utf8') / 3);
}

export function costUsd(inputTokens, outputTokens) {
  return (inputTokens * REVIEW_PRICE.inputUsdPerMillion + outputTokens * REVIEW_PRICE.outputUsdPerMillion) / 1_000_000;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/** The verdicts of one answer, checked against the schema and the call's keys; throws on any problem. */
export function validateVerdicts(answer, call) {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('answer is not an object');
  const extra = Object.keys(answer).filter(key => key !== 'verdicts');
  if (extra.length > 0 || !Array.isArray(answer.verdicts)) throw new Error('answer is not {verdicts: [...]}');
  const keys = (call.analysis?.proposals ?? []).map(proposal => proposal.key);
  const kinds = new Map((call.analysis?.proposals ?? []).map(proposal => [proposal.key, proposal.kind]));
  const seen = new Set();
  const out = [];
  for (const entry of answer.verdicts) {
    if (entry === null || typeof entry !== 'object') throw new Error('a verdict is not an object');
    const allowed = ['key', 'verdict', 'category', 'reason', 'decisionMatchesEvidence'];
    if (Object.keys(entry).some(key => !allowed.includes(key)) || allowed.some(key => !(key in entry))) throw new Error('a verdict has the wrong fields');
    if (typeof entry.key !== 'string' || !kinds.has(entry.key)) throw new Error('a verdict names a key the call does not have');
    if (seen.has(entry.key)) throw new Error('a key is answered twice');
    seen.add(entry.key);
    if (!['correct', 'incorrect', 'unclear'].includes(entry.verdict)) throw new Error('a verdict is not correct, incorrect or unclear');
    if (entry.verdict === 'incorrect') {
      if (!['false_positive', 'wrong_value', 'missed_context'].includes(entry.category)) throw new Error('an incorrect verdict has no category');
    } else if (entry.category !== null) throw new Error('only an incorrect verdict has a category');
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '' || entry.reason.length > REVIEW_REASON_MAX_CHARS) {
      throw new Error(`a reason is empty or longer than ${String(REVIEW_REASON_MAX_CHARS)} characters`);
    }
    if (!['yes', 'no', 'unclear', 'no_decision'].includes(entry.decisionMatchesEvidence)) throw new Error('decisionMatchesEvidence is not one of its values');
    out.push({
      callSessionId: call.callSessionId,
      analysisId: call.analysis.analysisId,
      key: entry.key,
      kind: kinds.get(entry.key),
      verdict: entry.verdict,
      category: entry.category,
      decisionMatchesEvidence: entry.decisionMatchesEvidence,
      reason: entry.reason,
    });
  }
  const missing = keys.filter(key => !seen.has(key));
  if (missing.length > 0) throw new Error(`${String(missing.length)} suggestion(s) have no verdict`);
  return out;
}

/** The answer's JSON from a Messages response body (Bedrock's InvokeModel answer). */
export function answerOf(response) {
  if (response === null || typeof response !== 'object') throw new Error('unreadable model response');
  if (response.stop_reason === 'refusal') throw new Error('the model refused');
  if (response.stop_reason === 'max_tokens') throw new Error('the answer was cut off at max_tokens');
  const text = (Array.isArray(response.content) ? response.content : []).filter(block => block?.type === 'text').map(block => block.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('the answer is not JSON');
  }
}

// ---------------------------------------------------------------------------
// The no-quote check
// ---------------------------------------------------------------------------

const wordsOf = text =>
  String(text)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’']/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length > 0);

/** Every run of `QUOTE_RUN_WORDS` consecutive words of the calls' transcripts (each turn, and across turns). */
export function transcriptRuns(calls) {
  const runs = new Set();
  for (const call of calls) {
    const words = (call.transcript?.turns ?? []).flatMap(turn => wordsOf(turn.text));
    for (let at = 0; at + QUOTE_RUN_WORDS <= words.length; at += 1) runs.add(words.slice(at, at + QUOTE_RUN_WORDS).join(' '));
  }
  return runs;
}

/** How many runs of the transcripts appear in the text: 0, or the run fails. Never says which. */
export function quotedRunCount(text, runs) {
  const words = wordsOf(text);
  let found = 0;
  for (let at = 0; at + QUOTE_RUN_WORDS <= words.length; at += 1) if (runs.has(words.slice(at, at + QUOTE_RUN_WORDS).join(' '))) found += 1;
  return found;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Review every call, one InvokeModel each, in order. `invoke(modelId, body)` answers the
 * response's parsed JSON; any error stops the run (no retry, no other provider). The cost of each
 * call is estimated before it (input bound + the maximum output) and the run stops before the
 * total could pass `capUsd`. After each call the estimate is replaced by the usage Bedrock
 * reports, when it reports one.
 */
export async function reviewCalls({ calls, invoke, capUsd = REVIEW_DEFAULT_CAP_USD, log = () => undefined }) {
  if (!(capUsd > 0)) throw new Error('the cap must be above $0');
  let spentUsd = 0;
  const verdicts = [];
  for (const [index, call] of calls.entries()) {
    const request = reviewRequestOf(call);
    const body = JSON.stringify(request);
    const estimate = costUsd(inputTokenBound(body), REVIEW_MAX_OUTPUT_TOKENS);
    if (spentUsd + estimate > capUsd) {
      log(`stop: call ${String(index + 1)} of ${String(calls.length)} could cost up to $${estimate.toFixed(4)}, and $${spentUsd.toFixed(4)} is spent of the $${capUsd.toFixed(2)} cap`);
      return { verdicts, spentUsd, stoppedAtCap: true, reviewed: index };
    }
    const response = await invoke(REVIEW_MODEL.inferenceProfileId, body);
    const usage = response?.usage;
    const actual =
      usage !== undefined && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
        ? costUsd(usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), usage.output_tokens)
        : estimate;
    spentUsd += actual;
    verdicts.push(...validateVerdicts(answerOf(response), call));
    log(`call ${String(index + 1)} of ${String(calls.length)}: estimated up to $${estimate.toFixed(4)}, used $${actual.toFixed(4)}, running $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}`);
  }
  return { verdicts, spentUsd, stoppedAtCap: false, reviewed: calls.length };
}

/** The printed table: ids, kinds, verdicts, categories and reasons only. */
export function verdictTable(verdicts) {
  const header = ['call', 'key', 'kind', 'verdict', 'category', 'decision fits', 'reason'];
  const rows = verdicts.map(row => [row.callSessionId.slice(0, 8), row.key, row.kind, row.verdict, row.category ?? '-', row.decisionMatchesEvidence, row.reason]);
  return [header, ...rows].map(cells => cells.join(' | ')).join('\n');
}
