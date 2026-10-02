// The trial review's logic (slice S3T-E), used by review.mjs and tested with a stubbed Bedrock
// client (test/ops/trialReview.check.ts). Runs on David's Mac, never in the app.
//
// Nothing here prints transcript text, and nothing free-text is written anywhere: the model answers
// enums only (VERDICT_SCHEMA, no note: review TERF, finding 1), and what leaves this module
// (verdicts.json and stdout) is ids, kinds and enums only (OUTPUT_SCHEMA). The closed lists the
// export is checked against (proposal keys and kinds, call outcomes) are the contract's own,
// imported from @fss/contracts (review TERF, finding 3).

import { constants, createDecipheriv, createPrivateKey, privateDecrypt } from 'node:crypto';
import { CALL_OUTCOMES, CALL_PROPOSAL_KINDS, callProposalKeySchema } from '@fss/contracts';

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
  'E_PAYLOAD',
  'E_WRITE',
  'E_BEDROCK',
  'E_RESPONSE',
  'E_SCHEMA',
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
/** The shortest passphrase accepted, after trimming (review TERF, finding 5). */
export const PASSPHRASE_MIN_CHARS = 8;
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

/** How many PEM blocks a file holds. */
export function pemBlockCount(pem) {
  return (String(pem).match(/-----BEGIN [A-Z0-9 ]+-----/gu) ?? []).length;
}

/**
 * Refuse a key the passphrase does not actually protect (TE design reset, R4): the file holds
 * exactly one PEM block, and loading it WITHOUT a passphrase must throw. Called before the prompt.
 */
export function assertPassphraseRequired(pem) {
  if (pemBlockCount(pem) !== 1) throw new ToolError('E_KEY_UNPROTECTED', 'the key file must hold exactly one PEM block');
  let loaded = false;
  try {
    createPrivateKey({ key: pem, format: 'pem' });
    loaded = true;
  } catch {
    loaded = false;
  }
  if (loaded) throw new ToolError('E_KEY_UNPROTECTED', 'the key loads without a passphrase');
}

/**
 * The key, with the typed passphrase; E_KEY on any failure. An empty, blank or short passphrase
 * (under PASSPHRASE_MIN_CHARS once trimmed) is refused before the key is loaded: a key encrypted
 * with an empty passphrase would otherwise open with a blank line (review TERF, finding 5).
 */
export function loadPrivateKey(pem, passphrase) {
  assertPassphraseRequired(pem);
  if (typeof passphrase !== 'string' || passphrase.trim().length < PASSPHRASE_MIN_CHARS) throw new ToolError('E_KEY', `the passphrase is shorter than ${String(PASSPHRASE_MIN_CHARS)} characters`);
  try {
    return createPrivateKey({ key: pem, format: 'pem', passphrase });
  } catch {
    throw new ToolError('E_KEY', 'the passphrase does not open the key');
  }
}

/** The calls of a decrypted export, every workspace's, in order; each checked by `assertCanonicalCall`. */
export function callsOf(exported) {
  if (exported === null || typeof exported !== 'object' || !Array.isArray(exported.workspaces)) throw new ToolError('E_INPUT_PARSE');
  const calls = exported.workspaces.flatMap(workspace => (Array.isArray(workspace.calls) ? workspace.calls : []));
  for (const call of calls) assertCanonicalCall(call);
  return calls;
}

/** The contract's proposal kinds and call outcomes (packages/contracts), as this tool's closed lists. */
export const PROPOSAL_KINDS = Object.freeze([...CALL_PROPOSAL_KINDS]);
export const OUTCOMES = Object.freeze([...CALL_OUTCOMES]);

/**
 * Every proposal of a decrypted call is one the contract allows (review TERF, finding 3): its key
 * passes `callProposalKeySchema` (the kind for every kind but a task, `task:<16 hex>` for a task),
 * its kind is one of `CALL_PROPOSAL_KINDS` and agrees with the key, keys are unique, and an
 * outcome proposal's value is one of `CALL_OUTCOMES`. Throws E_PAYLOAD otherwise; the error names
 * no key (a key the contract does not allow could be any text).
 */
export function assertCanonicalCall(call) {
  const proposals = call?.analysis?.proposals;
  if (call === null || typeof call !== 'object' || !Array.isArray(proposals)) throw new ToolError('E_PAYLOAD', 'a call has no proposal list');
  const seen = new Set();
  for (const proposal of proposals) {
    const key = proposal?.key;
    const kind = proposal?.kind;
    if (typeof key !== 'string' || !callProposalKeySchema.safeParse(key).success) throw new ToolError('E_PAYLOAD', 'a proposal key is not one the contract allows');
    if (typeof kind !== 'string' || !PROPOSAL_KINDS.includes(kind)) throw new ToolError('E_PAYLOAD', 'a proposal kind is not one the contract allows');
    if (kind === 'task' ? !key.startsWith('task:') : key !== kind) throw new ToolError('E_PAYLOAD', 'a proposal key does not match its kind');
    if (seen.has(key)) throw new ToolError('E_PAYLOAD', 'a proposal key repeats');
    seen.add(key);
    if (kind === 'outcome' && !OUTCOMES.includes(proposal.params?.outcome)) throw new ToolError('E_PAYLOAD', 'an outcome proposal has no outcome the contract allows');
  }
}

/**
 * The reporting type of a proposal, as `acceptanceTypeOf` (packages/domain/calls/proposalMeasure.ts)
 * computes it; a test holds the two equal over every kind and outcome. From the export, never the
 * model (review TERF, finding 6).
 */
export function reportTypeOf(proposal) {
  if (proposal.kind === 'outcome') return proposal.params.outcome === 'do_not_call' ? 'stop' : `outcome:${proposal.params.outcome}`;
  if (proposal.kind === 'stop_scope') return 'stop';
  return proposal.kind;
}

/** Every reporting type there is. */
export const REPORT_TYPES = Object.freeze([
  ...new Set([
    ...OUTCOMES.map(outcome => reportTypeOf({ kind: 'outcome', params: { outcome } })),
    ...PROPOSAL_KINDS.filter(kind => kind !== 'outcome').map(kind => reportTypeOf({ kind })),
  ]),
]);

/** The proposed value of an outcome proposal; `none` for every other kind. */
export function proposedValueOf(proposal) {
  return proposal.kind === 'outcome' ? proposal.params.outcome : 'none';
}
export const PROPOSED_VALUES = Object.freeze([...OUTCOMES, 'none']);

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * Why a verdict is what it is: a closed list, so the coordinator-facing output carries no free
 * text (TE design reset, R2).
 */
export const REASON_CODES = Object.freeze([
  'supported_by_statement',
  'no_supporting_statement',
  'value_differs_from_statement',
  'statement_was_conditional',
  'speaker_not_decision_maker',
  'later_statement_reversed',
  'outcome_mislabelled',
  'time_or_date_differs',
  'scope_differs',
  'transcript_unclear',
  'other',
]);
export const VERDICTS = Object.freeze(['correct', 'incorrect', 'unclear']);
export const CATEGORIES = Object.freeze(['false_positive', 'wrong_value', 'missed_context', 'none']);
export const DECISION_MATCHES = Object.freeze(['yes', 'no', 'unclear']);
/** David's decision on the suggestion, from the export (not the model). */
export const DECISIONS = Object.freeze(['unchanged', 'edited', 'declined', 'bypassed', 'none']);

export const REVIEW_SYSTEM = [
  'You review the suggestions an assistant made after a sales call, against the call transcript.',
  'You are given the transcript (numbered lines, "You" is the caller, "Them" is the prospect), every suggestion with its evidence lines,',
  "the caller's decision on each suggestion (unchanged, edited, declined, bypassed; or none), any later correction, and the outcome he logged.",
  'For EVERY suggestion, by its key:',
  '- verdict: "correct" if the transcript supports it as proposed, "incorrect" if it does not, "unclear" if the transcript cannot tell;',
  '- category: when incorrect, "false_positive" (nothing in the call called for it), "wrong_value" (right kind, wrong value such as the outcome, time or scope), or "missed_context" (something later or elsewhere in the call changes it); otherwise "none";',
  `- reason_code: one of ${REASON_CODES.map(code => `"${code}"`).join(', ')};`,
  '- decision_matches_evidence: "yes" if the caller\'s decision fits the transcript, "no" if it does not, "unclear" (also when he made no decision);',
  'Answer only with the JSON the schema describes, one entry per suggestion key, each key exactly once.',
].join('\n');

/** The model's answer (structured outputs: closed objects, every property required). */
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
        required: ['key', 'verdict', 'category', 'reason_code', 'decision_matches_evidence'],
        properties: {
          key: { type: 'string' },
          verdict: { type: 'string', enum: [...VERDICTS] },
          category: { type: 'string', enum: [...CATEGORIES] },
          reason_code: { type: 'string', enum: [...REASON_CODES] },
          decision_matches_evidence: { type: 'string', enum: [...DECISION_MATCHES] },
        },
      },
    },
  },
});

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
/** The contract's keys exactly: a kind other than `task`, or `task:<16 hex>`. */
const KEY = `^(?:${PROPOSAL_KINDS.filter(kind => kind !== 'task').join('|')}|task:[0-9a-f]{16})$`;

/**
 * verdicts.json, the coordinator-facing output: ids, kinds and enums only. No string field is
 * anything but an id (a pattern) or an enum.
 */
export const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['model', 'reviewed', 'of', 'stoppedAtCap', 'estimatedUsd', 'verdicts'],
  properties: {
    model: { type: 'string', enum: ['us.anthropic.claude-sonnet-4-6'] },
    reviewed: { type: 'integer' },
    of: { type: 'integer' },
    stoppedAtCap: { type: 'boolean' },
    estimatedUsd: { type: 'number' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['callSessionId', 'analysisId', 'key', 'kind', 'report_type', 'proposed_value', 'decision', 'verdict', 'category', 'reason_code', 'decision_matches_evidence'],
        properties: {
          callSessionId: { type: 'string', pattern: UUID },
          analysisId: { type: 'string', pattern: UUID },
          key: { type: 'string', pattern: KEY },
          kind: { type: 'string', enum: [...PROPOSAL_KINDS] },
          report_type: { type: 'string', enum: [...REPORT_TYPES] },
          proposed_value: { type: 'string', enum: [...PROPOSED_VALUES] },
          decision: { type: 'string', enum: [...DECISIONS] },
          verdict: { type: 'string', enum: [...VERDICTS] },
          category: { type: 'string', enum: [...CATEGORIES] },
          reason_code: { type: 'string', enum: [...REASON_CODES] },
          decision_matches_evidence: { type: 'string', enum: [...DECISION_MATCHES] },
        },
      },
    },
  },
});

/** Validate a value against a schema of the shapes above (object, array, string enum/pattern, integer, number, boolean). */
export function schemaViolations(value, schema, path = '$') {
  const problems = [];
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${path}: not an object`];
    const keys = Object.keys(value);
    for (const key of keys) if (!(key in schema.properties)) problems.push(`${path}.${key}: not allowed`);
    for (const key of schema.required) if (!keys.includes(key)) problems.push(`${path}.${key}: missing`);
    for (const [key, child] of Object.entries(schema.properties)) if (key in value) problems.push(...schemaViolations(value[key], child, `${path}.${key}`));
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: not an array`];
    value.forEach((item, index) => problems.push(...schemaViolations(item, schema.items, `${path}[${String(index)}]`)));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${path}: not a string`];
    if (schema.enum !== undefined && !schema.enum.includes(value)) problems.push(`${path}: not one of its values`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${path}: not an id`);
    if (schema.enum === undefined && schema.pattern === undefined) problems.push(`${path}: a free string`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) problems.push(`${path}: not an integer`);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${path}: not a number`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') problems.push(`${path}: not a boolean`);
  } else problems.push(`${path}: an unknown schema`);
  return problems;
}

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

/** David's latest decision on each key of the call's analysis, from the export. */
function decisionsOf(call) {
  const latest = new Map();
  for (const decision of call.decisions ?? []) if (decision.analysisId === call.analysis.analysisId) latest.set(decision.key, decision.result);
  return latest;
}

/**
 * One answer, checked against the model schema (closed objects: any extra property, a `note`
 * included, is refused) and the call's keys; throws E_SCHEMA on any problem, E_PAYLOAD if the
 * call itself is not canonical. Returns the enum-only verdicts, with the reporting type and the
 * proposed value taken from the export.
 */
export function validateVerdicts(answer, call) {
  assertCanonicalCall(call);
  const items = VERDICT_SCHEMA.properties.verdicts.items;
  const problems = schemaViolations(answer, { ...VERDICT_SCHEMA, properties: { verdicts: { type: 'array', items: { ...items, properties: { ...items.properties, key: { type: 'string', pattern: KEY } } } } } });
  if (problems.length > 0) throw new ToolError('E_SCHEMA', 'the answer does not match the schema');
  const proposals = new Map(call.analysis.proposals.map(proposal => [proposal.key, proposal]));
  const decided = decisionsOf(call);
  const seen = new Set();
  const verdicts = [];
  for (const entry of answer.verdicts) {
    if (!proposals.has(entry.key)) throw new ToolError('E_SCHEMA', 'a verdict names a key the call does not have');
    if (seen.has(entry.key)) throw new ToolError('E_SCHEMA', 'a key is answered twice');
    seen.add(entry.key);
    if ((entry.verdict === 'incorrect') !== (entry.category !== 'none')) throw new ToolError('E_SCHEMA', 'a category is set exactly when the verdict is incorrect');
    const proposal = proposals.get(entry.key);
    const decision = decided.get(entry.key) ?? 'none';
    verdicts.push({
      callSessionId: call.callSessionId,
      analysisId: call.analysis.analysisId,
      key: entry.key,
      kind: proposal.kind,
      report_type: reportTypeOf(proposal),
      proposed_value: proposedValueOf(proposal),
      decision: DECISIONS.includes(decision) ? decision : 'none',
      verdict: entry.verdict,
      category: entry.category,
      reason_code: entry.reason_code,
      decision_matches_evidence: entry.decision_matches_evidence,
    });
  }
  const missing = [...proposals.keys()].filter(key => !seen.has(key));
  if (missing.length > 0) throw new ToolError('E_SCHEMA', `${String(missing.length)} suggestion(s) have no verdict`);
  return { verdicts };
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
    const checked = validateVerdicts(answerOf(response), call);
    verdicts.push(...checked.verdicts);
    log(`call ${String(index + 1)} of ${String(calls.length)}: bound ${String(bound)} input + ${String(REVIEW_MAX_OUTPUT_TOKENS)} output tokens = $${estimate.toFixed(4)}, used $${actual.toFixed(4)}, running $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}`);
  }
  return { verdicts, spentUsd, stoppedAtCap: false, reviewed: calls.length };
}

/** The printed table: ids, kinds and enums only. */
export function verdictTable(verdicts) {
  const header = ['call', 'key', 'kind', 'report_type', 'proposed_value', 'decision', 'verdict', 'category', 'reason_code', 'decision_fits'];
  const rows = verdicts.map(row => [row.callSessionId.slice(0, 8), row.key, row.kind, row.report_type, row.proposed_value, row.decision, row.verdict, row.category, row.reason_code, row.decision_matches_evidence]);
  return [header, ...rows].map(cells => cells.join(' | ')).join('\n');
}

/** Every string the coordinator-facing output emits (verdicts.json and stdout), in order. */
export function emittedStrings(...values) {
  const strings = [];
  const walk = value => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  values.forEach(walk);
  return strings;
}

/**
 * The quote check over the concatenation of every emitted string (TE design reset, R2): a quote
 * split across fields, or across a field and a stdout line, is one text here.
 */
export function emittedQuoteCount(runs, ...values) {
  return quotedRunCount(emittedStrings(...values).join(' '), runs);
}
