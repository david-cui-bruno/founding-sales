// The trial review's logic (slice S3T-E), shared by decrypt.mjs and review.mjs and tested with a
// stubbed Bedrock client (test/ops/trialReview.check.ts). Runs on David's Mac, never in the app.
//
// Nothing here prints transcript text. The only things that leave this module on stdout are ids,
// kinds, verdicts, categories, the model's reasons (checked for quotes) and cost estimates.

import { constants, createDecipheriv, privateDecrypt } from 'node:crypto';

export const EXPORT_ALG = 'RSA-OAEP-256+A256GCM';

/**
 * Every failure the tools report, as a fixed code: nothing else is ever printed about an error
 * (an error's message can carry a fragment of its input: Node's JSON parser quotes it).
 */
export const ERROR_CODES = Object.freeze([
  'E_ARGS',
  'E_INPUT_PARSE',
  'E_KEY',
  'E_KEY_UNPROTECTED',
  'E_DECRYPT',
  'E_WRITE',
  'E_BEDROCK',
  'E_RESPONSE',
  'E_SCHEMA',
  'E_OUTPUT_CHARS',
  'E_QUOTE',
  'E_COST',
  'E_CLEANUP',
  'E_INTERRUPTED',
  'E_INTERNAL',
]);

export class ToolError extends Error {
  /** `detail` is a fixed sentence of this file's, never input; the tests read it, nothing prints it. */
  constructor(code, detail = '') {
    super(code);
    this.code = ERROR_CODES.includes(code) ? code : 'E_INTERNAL';
    this.detail = detail;
  }
}

/** The code of any error: its own if it is a ToolError, else the caller's fallback. */
export function codeOf(error, fallback = 'E_INTERNAL') {
  return error instanceof ToolError ? error.code : ERROR_CODES.includes(fallback) ? fallback : 'E_INTERNAL';
}

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
/** A run of this many words of the transcript, anywhere in the output, fails the run (TE review: 6, from 8). */
export const QUOTE_RUN_WORDS = 6;
/** The same check with every separator removed: this many letters and digits in a row. */
export const QUOTE_RUN_CHARACTERS = 30;

// ---------------------------------------------------------------------------
// The export: lines, parts, the envelope
// ---------------------------------------------------------------------------

/**
 * The export's parts in a text: one JSON object per line, as `fss admin trial export` printed it,
 * wherever it sits in the line (the ops helper indents the task's log lines). Exactly one export:
 * every part agrees on `exportId` and `of`, the parts are exactly 1..of, each once (an identical
 * repeat is tolerated, a different one refused). Throws E_INPUT_PARSE otherwise.
 */
export function readExportParts(text) {
  const found = [];
  for (const raw of String(text).split(/\r?\n/u)) {
    const start = raw.indexOf('{');
    if (start < 0) continue;
    let value;
    try {
      value = JSON.parse(raw.slice(start).trim());
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || value.v !== 1 || value.alg !== EXPORT_ALG) continue;
    found.push({ value, line: raw.slice(start).trim() });
  }
  const ids = new Set(found.map(entry => entry.value.exportId));
  if (found.length === 0 || ids.size !== 1) throw new ToolError('E_INPUT_PARSE');
  const totals = new Set(found.map(entry => entry.value.of));
  const of = found[0].value.of;
  if (totals.size !== 1 || !Number.isInteger(of) || of < 1) throw new ToolError('E_INPUT_PARSE');
  const byPart = new Map();
  for (const entry of found) {
    const index = entry.value.part;
    if (!Number.isInteger(index) || index < 1 || index > of) throw new ToolError('E_INPUT_PARSE');
    const earlier = byPart.get(index);
    if (earlier !== undefined && earlier.line !== entry.line) throw new ToolError('E_INPUT_PARSE');
    byPart.set(index, entry);
  }
  if (byPart.size !== of) throw new ToolError('E_INPUT_PARSE');
  return [...Array(of).keys()].map(index => byPart.get(index + 1).value);
}

const TAG_BYTES = 16;
const IV_BYTES = 12;

/** A part's AAD: its envelope fields, exactly as the export bound them. */
export function partAad(part) {
  return Buffer.from(JSON.stringify({ v: part.v, alg: part.alg, exportId: part.exportId, part: part.part, of: part.of }), 'utf8');
}

/**
 * The plaintext JSON of an export, with the private key (a KeyObject). Each part is checked on
 * its own: a 12-byte IV, a 16-byte tag (no shorter tag is accepted), and its envelope as AAD.
 * Throws E_DECRYPT on any failure.
 */
export function decryptExport(parts, privateKey) {
  let contentKey;
  try {
    const first = parts[0];
    if (first === undefined || typeof first.wrappedKey !== 'string') throw new ToolError('E_DECRYPT');
    contentKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(first.wrappedKey, 'base64'));
    if (contentKey.length !== 32) throw new ToolError('E_DECRYPT');
    const slices = parts.map(part => {
      const iv = Buffer.from(String(part.iv ?? ''), 'base64');
      const tag = Buffer.from(String(part.tag ?? ''), 'base64');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new ToolError('E_DECRYPT');
      const decipher = createDecipheriv('aes-256-gcm', contentKey, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(partAad(part));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(String(part.ciphertext ?? ''), 'base64')), decipher.final()]);
    });
    return JSON.parse(Buffer.concat(slices).toString('utf8'));
  } catch {
    throw new ToolError('E_DECRYPT');
  } finally {
    contentKey?.fill(0);
  }
}

/** A PEM the passphrase protects: PKCS#8 `ENCRYPTED PRIVATE KEY`, or the legacy `Proc-Type: 4,ENCRYPTED`. */
export function isProtectedPem(pem) {
  return /-----BEGIN ENCRYPTED PRIVATE KEY-----/u.test(pem) || /^Proc-Type:\s*4,ENCRYPTED\s*$/mu.test(pem);
}

/** The calls of a decrypted export, every workspace's, in order. */
export function callsOf(exported) {
  if (exported === null || typeof exported !== 'object' || !Array.isArray(exported.workspaces)) throw new ToolError('E_INPUT_PARSE');
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

/**
 * An upper bound on the input tokens: the UTF-8 bytes of the whole request body. No tokenizer
 * makes more tokens than bytes (TE review, finding 8: bytes/3 was a heuristic, not a bound;
 * https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html).
 */
export function inputTokenBound(body) {
  return Buffer.byteLength(body, 'utf8');
}

export function costUsd(inputTokens, outputTokens) {
  return (inputTokens * REVIEW_PRICE.inputUsdPerMillion + outputTokens * REVIEW_PRICE.outputUsdPerMillion) / 1_000_000;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/** The verdicts of one answer, checked against the schema and the call's keys; throws on any problem. */
export function validateVerdicts(answer, call) {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) throw new ToolError('E_SCHEMA', 'answer is not an object');
  const extra = Object.keys(answer).filter(key => key !== 'verdicts');
  if (extra.length > 0 || !Array.isArray(answer.verdicts)) throw new ToolError('E_SCHEMA', 'answer is not {verdicts: [...]}');
  const keys = (call.analysis?.proposals ?? []).map(proposal => proposal.key);
  const kinds = new Map((call.analysis?.proposals ?? []).map(proposal => [proposal.key, proposal.kind]));
  const seen = new Set();
  const out = [];
  for (const entry of answer.verdicts) {
    if (entry === null || typeof entry !== 'object') throw new ToolError('E_SCHEMA', 'a verdict is not an object');
    const allowed = ['key', 'verdict', 'category', 'reason', 'decisionMatchesEvidence'];
    if (Object.keys(entry).some(key => !allowed.includes(key)) || allowed.some(key => !(key in entry))) throw new ToolError('E_SCHEMA', 'a verdict has the wrong fields');
    if (typeof entry.key !== 'string' || !kinds.has(entry.key)) throw new ToolError('E_SCHEMA', 'a verdict names a key the call does not have');
    if (seen.has(entry.key)) throw new ToolError('E_SCHEMA', 'a key is answered twice');
    seen.add(entry.key);
    if (!['correct', 'incorrect', 'unclear'].includes(entry.verdict)) throw new ToolError('E_SCHEMA', 'a verdict is not correct, incorrect or unclear');
    if (entry.verdict === 'incorrect') {
      if (!['false_positive', 'wrong_value', 'missed_context'].includes(entry.category)) throw new ToolError('E_SCHEMA', 'an incorrect verdict has no category');
    } else if (entry.category !== null) throw new ToolError('E_SCHEMA', 'only an incorrect verdict has a category');
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '' || entry.reason.length > REVIEW_REASON_MAX_CHARS) {
      throw new ToolError('E_SCHEMA', `a reason is empty or longer than ${String(REVIEW_REASON_MAX_CHARS)} characters`);
    }
    if (!['yes', 'no', 'unclear', 'no_decision'].includes(entry.decisionMatchesEvidence)) throw new ToolError('E_SCHEMA', 'decisionMatchesEvidence is not one of its values');
    // Printable ASCII only, after NFKC: an invisible or look-alike character is refused, never
    // cleaned (TE review, finding 1).
    for (const field of allowed) {
      const value = entry[field];
      if (typeof value === 'string' && !/^[\x20-\x7E]*$/u.test(value.normalize('NFKC'))) throw new ToolError('E_OUTPUT_CHARS', 'a field holds a character outside printable ASCII');
    }
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
  if (missing.length > 0) throw new ToolError('E_SCHEMA', `${String(missing.length)} suggestion(s) have no verdict`);
  return out;
}

/** The answer's JSON from a Messages response body (Bedrock's InvokeModel answer). */
export function answerOf(response) {
  if (response === null || typeof response !== 'object') throw new ToolError('E_RESPONSE', 'unreadable model response');
  if (response.stop_reason === 'refusal') throw new ToolError('E_RESPONSE', 'the model refused');
  if (response.stop_reason === 'max_tokens') throw new ToolError('E_RESPONSE', 'the answer was cut off at max_tokens');
  const text = (Array.isArray(response.content) ? response.content : []).filter(block => block?.type === 'text').map(block => block.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError('E_RESPONSE', 'the answer is not JSON');
  }
}

// ---------------------------------------------------------------------------
// The no-quote check
// ---------------------------------------------------------------------------

/**
 * The text the quote check compares (TE review, finding 1): NFKC, then NFKD with every
 * combining mark (Mn, Mc, Me) and format character (Cf: zero-width space and joiner, soft
 * hyphen, bidi marks) removed, lowercased.
 */
export function foldForQuoteCheck(text) {
  return String(text)
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .toLowerCase();
}

/** Its tokens: runs of a-z and 0-9 only. */
const wordsOf = text => foldForQuoteCheck(text).match(/[a-z0-9]+/gu) ?? [];
/** Its letters and digits with everything between them removed, so "de.mo" is "demo". */
const squashed = text => wordsOf(text).join('');

/** The transcripts' runs: every `QUOTE_RUN_WORDS` consecutive tokens, and every `QUOTE_RUN_CHARACTERS` squashed characters. */
export function transcriptRuns(calls) {
  const words = new Set();
  const characters = new Set();
  for (const call of calls) {
    const tokens = (call.transcript?.turns ?? []).flatMap(turn => wordsOf(turn.text));
    for (let at = 0; at + QUOTE_RUN_WORDS <= tokens.length; at += 1) words.add(tokens.slice(at, at + QUOTE_RUN_WORDS).join(' '));
    const joined = tokens.join('');
    for (let at = 0; at + QUOTE_RUN_CHARACTERS <= joined.length; at += 1) characters.add(joined.slice(at, at + QUOTE_RUN_CHARACTERS));
  }
  return { words, characters };
}

/** How many runs of the transcripts appear in the text: 0, or the run fails. Never says which. */
export function quotedRunCount(text, runs) {
  const tokens = wordsOf(text);
  let found = 0;
  for (let at = 0; at + QUOTE_RUN_WORDS <= tokens.length; at += 1) if (runs.words.has(tokens.slice(at, at + QUOTE_RUN_WORDS).join(' '))) found += 1;
  const joined = squashed(text);
  for (let at = 0; at + QUOTE_RUN_CHARACTERS <= joined.length; at += 1) if (runs.characters.has(joined.slice(at, at + QUOTE_RUN_CHARACTERS))) found += 1;
  return found;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Review every call, one InvokeModel each, in order. `invoke(modelId, body)` answers the
 * response's parsed JSON; any error stops the run (no retry, no other provider). The cost of each
 * call is bounded before it (the body's UTF-8 bytes as input tokens, plus the maximum output) and
 * the run stops before the total could pass `capUsd`; what Bedrock reports never exceeds it. After each call the estimate is replaced by the usage Bedrock
 * reports, when it reports one.
 */
export async function reviewCalls({ calls, invoke, capUsd = REVIEW_DEFAULT_CAP_USD, log = () => undefined }) {
  if (!(capUsd > 0)) throw new ToolError('E_ARGS', 'the cap must be above $0');
  let spentUsd = 0;
  const verdicts = [];
  for (const [index, call] of calls.entries()) {
    const request = reviewRequestOf(call);
    const body = JSON.stringify(request);
    const bound = inputTokenBound(body);
    const estimate = costUsd(bound, REVIEW_MAX_OUTPUT_TOKENS);
    if (spentUsd + estimate > capUsd) {
      log(`stop: call ${String(index + 1)} of ${String(calls.length)} could cost up to $${estimate.toFixed(4)} (${String(bound)} input tokens at most, ${String(REVIEW_MAX_OUTPUT_TOKENS)} output), and $${spentUsd.toFixed(4)} is spent of the $${capUsd.toFixed(2)} cap`);
      return { verdicts, spentUsd, stoppedAtCap: true, reviewed: index };
    }
    let response;
    try {
      response = await invoke(REVIEW_MODEL.inferenceProfileId, body);
    } catch {
      throw new ToolError('E_BEDROCK', 'the InvokeModel request failed');
    }
    const usage = response?.usage;
    const actual =
      usage !== undefined && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
        ? costUsd(usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), usage.output_tokens)
        : estimate;
    spentUsd += actual;
    verdicts.push(...validateVerdicts(answerOf(response), call));
    log(`call ${String(index + 1)} of ${String(calls.length)}: bound ${String(bound)} input + ${String(REVIEW_MAX_OUTPUT_TOKENS)} output tokens = $${estimate.toFixed(4)}, used $${actual.toFixed(4)}, running $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}`);
  }
  return { verdicts, spentUsd, stoppedAtCap: false, reviewed: calls.length };
}

/** The printed table: ids, kinds, verdicts, categories and reasons only. */
export function verdictTable(verdicts) {
  const header = ['call', 'key', 'kind', 'verdict', 'category', 'decision fits', 'reason'];
  const rows = verdicts.map(row => [row.callSessionId.slice(0, 8), row.key, row.kind, row.verdict, row.category ?? '-', row.decisionMatchesEvidence, row.reason]);
  return [header, ...rows].map(cells => cells.join(' | ')).join('\n');
}
