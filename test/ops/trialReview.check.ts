import { spawn, spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CALL_OUTCOMES, CALL_PROPOSAL_KINDS, type CallProposal } from '@fss/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { encryptTrialExport, readTrialExportPublicKey } from '../../apps/worker/src/tools/fss/trialExport.ts';
import { acceptanceTypeOf } from '../../packages/domain/calls/proposalMeasure.ts';
import { schemaProblems } from '../../packages/domain/test/support/structuredOutputsSchema.ts';
import {
  OUTCOMES,
  OUTPUT_SCHEMA,
  PASSPHRASE_MIN_CHARS,
  PROPOSAL_KINDS,
  REPORT_TYPES,
  REASON_CODES,
  REVIEW_MODEL,
  ToolError,
  VERDICT_SCHEMA,
  assertCanonicalCall,
  assertPassphraseRequired,
  callsOf,
  decryptExport,
  emittedQuoteCount,
  foldForQuoteCheck,
  inputTokenBound,
  loadPrivateKey,
  quotedRunCount,
  readExportParts,
  reportTypeOf,
  reviewCalls,
  reviewRequestOf,
  schemaViolations,
  transcriptRuns,
  validateVerdicts,
  type ReviewCall,
} from '../../tools/trial-review/lib.mjs';
import { repositoryPath } from './support/repository.ts';

/**
 * Slice S3T-E after the TE design reset: `tools/trial-review/review.mjs` as David runs it — one
 * process that decrypts in memory, reviews through a stubbed Bedrock client
 * (`FSS_TRIAL_REVIEW_STUB`, a module the test writes; no request leaves the machine) and writes
 * only an enum-only verdicts.json (no free text anywhere: review TERF). Covers: R1 (no plaintext file;
 * the export removed on every exit after the arguments parse, signals included), R2 (no free text
 * in verdicts.json or stdout; the quote check over the concatenation of everything emitted), R4
 * (a key that loads without a passphrase is refused, the appended-marker case included), and the
 * earlier fixes still standing (GCM, codes only, the byte cost bound, the cap), and the TERF round:
 * no notes, canonical proposal keys (E_PAYLOAD), every exit removes the export or fails with
 * E_CLEANUP, an empty or short passphrase refused, and the reporting type per row.
 *
 * Fictional throughout: "Dana", `example.test`.
 */

const node = process.execPath;
const tool = (name: string): string => repositoryPath(`tools/trial-review/${name}`);
const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const PASSPHRASE = ['trial', 'review', 'passphrase'].join('-');
const pair = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSPHRASE },
});
const realKey = () => createPrivateKey({ key: pair.privateKey, passphrase: PASSPHRASE });
const plainPem = (): string => String(realKey().export({ type: 'pkcs8', format: 'pem' }));

const SPOKEN = 'we are evaluating three tools this quarter and would like a short demo next week if possible';

function call(id: string, keys: readonly string[] = ['outcome', 'buying_signal']): ReviewCall {
  return {
    callSessionId: id,
    firmId: '22222222-2222-4222-8222-222222222222',
    contactId: null,
    occurredAt: '2026-10-02T15:00:00.000Z',
    callSeconds: 120,
    recordingSeconds: 121,
    transcript: {
      channelLabelled: true,
      turns: [
        { line: 1, speaker: 'You', start: 0, end: 4, text: 'Hi [contact], this is David from Callie.' },
        { line: 2, speaker: 'Them', start: 5, end: 9, text: SPOKEN },
      ],
    },
    analysis: {
      analysisId: '33333333-3333-4333-8333-333333333333',
      version: 1,
      proposals: keys.map(key => {
        const evidence = [{ line: 2, side: 'them', start: 5, end: 9, quote: 'a short demo next week' }];
        return { key, kind: key, mode: 'apply', reason: 'From the call.', params: key === 'outcome' ? { outcome: 'interested', evidence } : { evidence } };
      }),
    },
    decisions: [{ analysisId: '33333333-3333-4333-8333-333333333333', key: 'outcome', type: 'outcome:interested', result: 'unchanged', at: '2026-10-02T15:05:00.000Z' }],
    corrections: [],
    loggedOutcome: { outcome: 'interested', occurredAt: '2026-10-02T15:05:00.000Z' },
  };
}

const CALLS = [call('55555555-5555-4555-8555-555555555555'), call('66666666-6666-4666-8666-666666666666')];
const exported = { format: 'fss.trial-export.v1', since: '2026-10-02T07:14:00.000Z', workspaces: [{ workspaceId: '11111111-1111-4111-8111-111111111111', calls: CALLS }] };

const entry = (key: string, patch: Record<string, unknown> = {}) => ({
  key,
  verdict: 'correct',
  category: 'none',
  reason_code: 'supported_by_statement',
  decision_matches_evidence: key === 'outcome' ? 'yes' : 'unclear',
  ...patch,
});
const answerOfEntries = (entries: readonly unknown[]) => ({
  content: [{ type: 'text', text: JSON.stringify({ verdicts: entries }) }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 900, output_tokens: 120 },
});
const goodAnswer = (keys: readonly string[] = ['outcome', 'buying_signal'], patch: Record<string, unknown> = {}) => answerOfEntries(keys.map(key => entry(key, patch)));

/** A folder holding the export as the ops helper prints it (indented, among other log lines), and the key. */
function exportFolder(pem: string = pair.privateKey, payload: unknown = exported): string {
  const folder = mkdtempSync(join(tmpdir(), 'fss-trial-review-'));
  folders.push(folder);
  const key = readTrialExportPublicKey(Buffer.from(pair.publicKey).toString('base64'));
  if (!key.ok) throw new Error(key.reason);
  const lines = encryptTrialExport(Buffer.from(JSON.stringify(payload)), key.key, 2_000);
  writeFileSync(join(folder, 'trial-export.jsonl'), ['operations: log stream …', ...lines.map(line => `  ${line}`), '  {"exported":2}', ''].join('\n'));
  writeFileSync(join(folder, 'key.pem'), pem, { mode: 0o600 });
  return folder;
}
const partsOf = (folder: string) => readExportParts(readFileSync(join(folder, 'trial-export.jsonl'), 'utf8'));

/** A stub Bedrock module: answers from a script file, and records every request it is asked. */
function stub(folder: string, answers: readonly unknown[]): { readonly env: NodeJS.ProcessEnv; readonly asked: () => number } {
  const script = join(folder, '..', `${folder.split('/').pop() ?? 'x'}-stub.json`);
  const record = `${script}.asked`;
  writeFileSync(script, JSON.stringify(answers));
  const module = `${script}.mjs`;
  writeFileSync(
    module,
    `import { appendFileSync, readFileSync } from 'node:fs';
export async function invoke(modelId, body) {
  appendFileSync(${JSON.stringify(record)}, JSON.stringify({ modelId, bytes: body.length }) + '\\n');
  const answers = JSON.parse(readFileSync(${JSON.stringify(script)}, 'utf8'));
  const asked = readFileSync(${JSON.stringify(record)}, 'utf8').trim().split('\\n').length;
  const answer = answers[asked - 1];
  if (answer === 'hang') return await new Promise(resolve => setTimeout(resolve, 60_000));
  if (answer === 'unsettled') return await new Promise(() => undefined);
  if (answer === undefined || answer === 'throw') throw new Error('stubbed Bedrock failure: evaluating three tools this quarter');
  return answer;
}
`,
  );
  folders.push(script, record, module);
  return {
    env: { ...process.env, FSS_TRIAL_REVIEW_STUB: pathToFileURL(module).href },
    asked: () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').length : 0),
  };
}

const review = (folder: string, env: NodeJS.ProcessEnv, extra: readonly string[] = [], passphrase = PASSPHRASE) =>
  spawnSync(node, [tool('review.mjs'), '--export', join(folder, 'trial-export.jsonl'), '--key', join(folder, 'key.pem'), ...extra], {
    env,
    input: `${passphrase}\n`,
    encoding: 'utf8',
  });

const exportGone = (folder: string): boolean => !existsSync(join(folder, 'trial-export.jsonl'));
/** No file in the folder holds plaintext: only the key and verdicts.json may be there. */
const onlyOutputs = (folder: string): string[] => readdirSync(folder).filter(name => !['key.pem', 'verdicts.json'].includes(name));

function thrown(action: () => unknown): { readonly code: string; readonly detail: string } {
  try {
    action();
  } catch (error) {
    if (error instanceof ToolError) return { code: error.code, detail: error.detail };
    throw error;
  }
  throw new Error('nothing was thrown');
}

describe('R1: one process, no plaintext on disk, the export removed on every exit', () => {
  it('reviews in memory: verdicts.json (0600) is the only file written, and the export is gone', () => {
    const folder = exportFolder();
    writeFileSync(join(folder, 'verdicts.json'), '{}', { mode: 0o644 });
    const stubbed = stub(folder, [goodAnswer(), goodAnswer()]);
    const result = review(folder, stubbed.env);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(stubbed.asked()).toBe(2);
    expect(exportGone(folder)).toBe(true);
    expect(readdirSync(folder).sort()).toEqual(['key.pem', 'verdicts.json']);
    expect(statSync(join(folder, 'verdicts.json')).mode & 0o777).toBe(0o600);
    expect(String(result.stderr)).toContain('removed the export');
  });

  it('a wrong passphrase removes the export too, with a code only', () => {
    const folder = exportFolder();
    const result = review(folder, stub(folder, []).env, [], 'wrong-passphrase');
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toMatch(/^review stopped: E_KEY\nremoved the export /u);
    expect(exportGone(folder)).toBe(true);
    expect(onlyOutputs(folder)).toEqual([]);
  });

  it('a malformed export, a schema failure and a Bedrock error each remove the export and print a code only', () => {
    const malformed = exportFolder();
    writeFileSync(join(malformed, 'trial-export.jsonl'), `{"v":1,"alg":"RSA-OAEP-256+A256GCM","exportId":"x","part":2,"of":2,"note":"${SPOKEN}"}\n`);
    const one = review(malformed, stub(malformed, []).env);
    expect([one.status, String(one.stderr).split('\n')[0]]).toEqual([1, 'review stopped: E_INPUT_PARSE']);
    expect(exportGone(malformed)).toBe(true);

    const schema = exportFolder();
    const two = review(schema, stub(schema, [goodAnswer(['outcome'])]).env);
    expect([two.status, String(two.stderr).split('\n')[0]]).toEqual([1, 'review stopped: E_SCHEMA']);
    expect(exportGone(schema)).toBe(true);

    const bedrock = exportFolder();
    const three = review(bedrock, stub(bedrock, ['throw']).env);
    expect([three.status, String(three.stderr).split('\n')[0]]).toEqual([1, 'review stopped: E_BEDROCK']);
    expect(String(three.stderr)).not.toContain('evaluating');
    expect(exportGone(bedrock)).toBe(true);
    for (const folder of [malformed, schema, bedrock]) expect(onlyOutputs(folder)).toEqual([]);
  });

  it('SIGINT, SIGTERM, SIGHUP and SIGQUIT during a Bedrock request remove the export and exit 130', async () => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
      const folder = exportFolder();
      const stubbed = stub(folder, ['hang']);
      const child = spawn(node, [tool('review.mjs'), '--export', join(folder, 'trial-export.jsonl'), '--key', join(folder, 'key.pem')], {
        env: stubbed.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
      });
      child.stdin.end(`${PASSPHRASE}\n`);
      for (let waited = 0; stubbed.asked() === 0 && waited < 10_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
      expect(stubbed.asked()).toBe(1);
      child.kill(signal);
      expect(await exited).toBe(130);
      expect(stderr).toMatch(/^review stopped: E_INTERRUPTED\nremoved the export /u);
      expect(exportGone(folder)).toBe(true);
      expect(onlyOutputs(folder)).toEqual([]);
    }
  });

  it('arguments that do not parse remove nothing (exit 2); the cap stop removes the export (exit 4)', () => {
    const folder = exportFolder();
    const bad = review(folder, stub(folder, []).env, ['--cap-usd', '0']);
    expect(bad.status).toBe(2);
    expect(String(bad.stderr).split('\n')[0]).toBe('review stopped: E_ARGS');
    expect(exportGone(folder)).toBe(false);
    const stubbed = stub(folder, [goodAnswer()]);
    const capped = review(folder, stubbed.env, ['--cap-usd', '0.01']);
    expect(capped.status, String(capped.stderr)).toBe(4);
    expect(stubbed.asked()).toBe(0);
    expect(String(capped.stdout)).toMatch(/stop: call 1 of 2 could cost up to \$[\d.]+ \(\d+ input tokens at most, 4000 output\)/u);
    expect(exportGone(folder)).toBe(true);
  });

  it('--out writes the outputs elsewhere; decrypt.mjs is gone', () => {
    const folder = exportFolder();
    const out = mkdtempSync(join(tmpdir(), 'fss-trial-out-'));
    folders.push(out);
    const result = review(folder, stub(folder, [goodAnswer(), goodAnswer()]).env, ['--out', out]);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(readdirSync(out)).toEqual(['verdicts.json']);
    expect(existsSync(tool('decrypt.mjs'))).toBe(false);
  });
});

describe('R2: the coordinator-facing output has no free text', () => {
  it('verdicts.json is ids, kinds and enums only, with the reporting type and proposed value from the export', () => {
    const folder = exportFolder();
    const result = review(folder, stub(folder, [goodAnswer(), goodAnswer()]).env);
    expect(result.status, String(result.stderr)).toBe(0);
    const output = JSON.parse(readFileSync(join(folder, 'verdicts.json'), 'utf8')) as Record<string, unknown>;
    expect(schemaViolations(output, OUTPUT_SCHEMA)).toEqual([]);
    expect(output['verdicts']).toEqual(
      expect.arrayContaining([
        {
          callSessionId: '55555555-5555-4555-8555-555555555555',
          analysisId: '33333333-3333-4333-8333-333333333333',
          key: 'outcome',
          kind: 'outcome',
          report_type: 'outcome:interested',
          proposed_value: 'interested',
          decision: 'unchanged',
          verdict: 'correct',
          category: 'none',
          reason_code: 'supported_by_statement',
          decision_matches_evidence: 'yes',
        },
      ]),
    );
    for (const text of [String(result.stdout), readFileSync(join(folder, 'verdicts.json'), 'utf8')]) expect(text).not.toContain('evaluating');
    expect(String(result.stdout)).toContain('55555555 | outcome | outcome | outcome:interested | interested | unchanged | correct | none | supported_by_statement | yes');
    expect(String(result.stdout)).toContain('55555555 | buying_signal | buying_signal | buying_signal | none | none | correct');
    expect(String(result.stdout)).toMatch(/reviewed 2 of 2; estimated \$[\d.]+; verdicts in \S+verdicts\.json\n$/u);
  });

  it('TERF 1: the model writes no note; an answer carrying one is refused (E_SCHEMA), nothing is written, the export goes', () => {
    const items = (VERDICT_SCHEMA['properties'] as { verdicts: { items: { required: string[]; properties: Record<string, unknown> } } }).verdicts.items;
    expect(items.required).not.toContain('note');
    expect(Object.keys(items.properties)).not.toContain('note');
    const folder = exportFolder();
    const leaky = goodAnswer(['outcome', 'buying_signal'], { note: SPOKEN.slice(0, 120) });
    const stubbed = stub(folder, [leaky, leaky]);
    const result = review(folder, stubbed.env);
    expect([result.status, String(result.stderr).split('\n')[0]]).toEqual([1, 'review stopped: E_SCHEMA']);
    expect(stubbed.asked()).toBe(1);
    expect(readdirSync(folder)).toEqual(['key.pem']);
    expect(String(result.stdout) + String(result.stderr)).not.toContain('three tools');
    expect(readFileSync(tool('review.mjs'), 'utf8')).not.toContain('reasons-for-david');
  });

  it('the output schema refuses any free string, extra field or value off its list', () => {
    const one = { callSessionId: '55555555-5555-4555-8555-555555555555', analysisId: '33333333-3333-4333-8333-333333333333', key: 'outcome', kind: 'outcome', report_type: 'stop', proposed_value: 'do_not_call', decision: 'none', verdict: 'correct', category: 'none', reason_code: 'other', decision_matches_evidence: 'yes' };
    const base = { model: 'us.anthropic.claude-sonnet-4-6', reviewed: 1, of: 1, stoppedAtCap: false, estimatedUsd: 0.1, verdicts: [one] };
    expect(schemaViolations(base, OUTPUT_SCHEMA)).toEqual([]);
    expect(schemaViolations({ ...base, verdicts: [{ ...one, note: 'we can do it' }] }, OUTPUT_SCHEMA)).not.toEqual([]);
    expect(schemaViolations({ ...base, verdicts: [{ ...one, reason_code: 'we can do it' }] }, OUTPUT_SCHEMA)).not.toEqual([]);
    expect(schemaViolations({ ...base, verdicts: [{ ...one, key: 'we can do it if you ask us' }] }, OUTPUT_SCHEMA)).not.toEqual([]);
    expect(schemaViolations({ ...base, verdicts: [{ ...one, key: 'we_can_do_it' }] }, OUTPUT_SCHEMA)).not.toEqual([]);
    expect(schemaViolations({ ...base, verdicts: [{ ...one, key: 'task:0123456789abcdef' }] }, OUTPUT_SCHEMA)).toEqual([]);
    expect(schemaViolations({ ...base, verdicts: [{ ...one, report_type: 'outcome:do_not_call' }] }, OUTPUT_SCHEMA)).not.toEqual([]);
    expect(schemaViolations({ ...base, verdicts: [{ ...one, proposed_value: 'maybe' }] }, OUTPUT_SCHEMA)).not.toEqual([]);
    expect(schemaViolations({ ...base, extra: 'x' }, OUTPUT_SCHEMA)).not.toEqual([]);
  });

  it('the model answer is validated: enums, each key once, a category exactly when incorrect', () => {
    const one = CALLS[0] as ReviewCall;
    expect(validateVerdicts(JSON.parse(String((goodAnswer().content[0] as { text: string }).text)), one).verdicts).toHaveLength(2);
    const bad = (entries: unknown[]) => thrown(() => validateVerdicts({ verdicts: entries }, one));
    expect(bad([entry('outcome')])).toEqual({ code: 'E_SCHEMA', detail: '1 suggestion(s) have no verdict' });
    expect(bad([entry('outcome'), entry('outcome')]).detail).toMatch(/twice/u);
    expect(bad([entry('outcome', { category: 'wrong_value' }), entry('buying_signal')]).detail).toMatch(/exactly when/u);
    expect(bad([entry('outcome', { verdict: 'incorrect' }), entry('buying_signal')]).detail).toMatch(/exactly when/u);
    expect(bad([entry('outcome', { reason_code: 'they said so' }), entry('buying_signal')]).code).toBe('E_SCHEMA');
    expect(bad([entry('outcome', { extra: 1 }), entry('buying_signal')]).code).toBe('E_SCHEMA');
    expect(bad([entry('outcome', { note: 'Line 2 supports it.' }), entry('buying_signal')])).toEqual({ code: 'E_SCHEMA', detail: 'the answer does not match the schema' });
    expect(bad([entry('outcome', { note: '' }), entry('buying_signal')]).code).toBe('E_SCHEMA');
    expect(bad([entry('park'), entry('outcome'), entry('buying_signal')]).detail).toMatch(/key the call does not have/u);
  });

  it('the lists: reason codes, and kinds equal to the contract', () => {
    expect(REASON_CODES).toEqual([
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
    expect([...PROPOSAL_KINDS]).toEqual([...CALL_PROPOSAL_KINDS]);
    expect([...OUTCOMES]).toEqual([...CALL_OUTCOMES]);
    expect(schemaProblems(VERDICT_SCHEMA)).toEqual([]);
    const request = reviewRequestOf(CALLS[0] as ReviewCall);
    expect(schemaProblems((request['output_config'] as { format: { schema: unknown } }).format.schema)).toEqual([]);
    expect(REVIEW_MODEL).toEqual({ inferenceProfileId: 'us.anthropic.claude-sonnet-4-6', foundationModelId: 'anthropic.claude-sonnet-4-6', region: 'us-east-1', profile: 'default' });
  });

  it('the quote check runs over the concatenation of everything emitted: a quote split across fields is caught', () => {
    const split = [{ ...exported.workspaces[0]?.calls[0], transcript: { turns: [{ line: 1, speaker: 'Them', start: 0, end: 5, text: 'we can do it if you ask us' }] } }] as unknown as ReviewCall[];
    const runs = transcriptRuns(split);
    expect(quotedRunCount('we can do it', runs) + quotedRunCount('if you ask us', runs)).toBe(0);
    expect(emittedQuoteCount(runs, { a: 'we can do it' }, ['if you ask us'])).toBeGreaterThan(0);
    expect(emittedQuoteCount(runs, { a: 'we can do', b: 'it if you' }, 'ask us')).toBeGreaterThan(0);
    expect(emittedQuoteCount(transcriptRuns(CALLS), { verdict: 'correct', reason_code: 'supported_by_statement' })).toBe(0);
    // The folding still holds.
    expect(foldForQuoteCheck('Démo​­')).toBe('demo');
  });
});

describe('TERF 3: every proposal key and kind is the contract\'s', () => {
  const aliased = (): ReviewCall => {
    const base = call('55555555-5555-4555-8555-555555555555');
    return {
      ...base,
      analysis: {
        ...base.analysis,
        proposals: [
          { key: 'we_can_do_it', kind: 'outcome', mode: 'apply', reason: 'Line 1.', params: { outcome: 'interested' } },
          { key: 'if_you_ask_us', kind: 'buying_signal', mode: 'apply', reason: 'Line 1.', params: {} },
        ],
      },
    };
  };

  it('the reviewer\'s phrase keys stop the run with E_PAYLOAD before any request, and no key is printed', () => {
    const folder = exportFolder(pair.privateKey, { ...exported, workspaces: [{ workspaceId: '11111111-1111-4111-8111-111111111111', calls: [aliased()] }] });
    const stubbed = stub(folder, [answerOfEntries([entry('we_can_do_it'), entry('if_you_ask_us')])]);
    const result = review(folder, stubbed.env);
    expect([result.status, String(result.stderr).split('\n')[0]]).toEqual([1, 'review stopped: E_PAYLOAD']);
    expect(stubbed.asked()).toBe(0);
    for (const text of [String(result.stdout), String(result.stderr)]) expect(text).not.toMatch(/we_can_do_it|if_you_ask_us/u);
    expect(readdirSync(folder)).toEqual(['key.pem']);
  });

  it('refuses a key off the contract, a kind off the contract, a key that is not its kind, a repeated key and an outcome off the list', () => {
    const with_ = (proposals: readonly Record<string, unknown>[]) => {
      const base = call('55555555-5555-4555-8555-555555555555');
      return { ...base, analysis: { ...base.analysis, proposals } } as unknown as ReviewCall;
    };
    const outcome = { key: 'outcome', kind: 'outcome', mode: 'apply', reason: 'r', params: { outcome: 'interested' } };
    expect(thrown(() => assertCanonicalCall(aliased())).code).toBe('E_PAYLOAD');
    expect(thrown(() => validateVerdicts({ verdicts: [entry('we_can_do_it'), entry('if_you_ask_us')] }, aliased())).code).toBe('E_PAYLOAD');
    expect(thrown(() => assertCanonicalCall(with_([{ ...outcome, kind: 'we_can_do_it', key: 'we_can_do_it' }]))).detail).not.toMatch(/we_can/u);
    expect(thrown(() => assertCanonicalCall(with_([{ ...outcome, key: 'park' }]))).code).toBe('E_PAYLOAD');
    expect(thrown(() => assertCanonicalCall(with_([{ ...outcome, key: 'task:0123456789abcdef' }]))).code).toBe('E_PAYLOAD');
    expect(thrown(() => assertCanonicalCall(with_([{ ...outcome, kind: 'task' }]))).code).toBe('E_PAYLOAD');
    expect(thrown(() => assertCanonicalCall(with_([outcome, outcome]))).code).toBe('E_PAYLOAD');
    expect(thrown(() => assertCanonicalCall(with_([{ ...outcome, params: { outcome: 'we can do it' } }]))).code).toBe('E_PAYLOAD');
    expect(() => assertCanonicalCall(with_([outcome, { key: 'task:0123456789abcdef', kind: 'task', mode: 'apply', reason: 'r', params: {} }]))).not.toThrow();
  });
});

describe('TERF 4: every exit removes the export, or fails', () => {
  it('an unsettled await (Node exits 13 without running finally) still removes the export', () => {
    const folder = exportFolder();
    const result = review(folder, stub(folder, ['unsettled']).env);
    expect(result.status).toBe(13);
    expect(String(result.stderr)).toMatch(/review stopped: E_INTERNAL\nremoved the export /u);
    expect(readdirSync(folder)).toEqual(['key.pem']);
  });

  it('an export that cannot be deleted prints E_CLEANUP and exits 3, even after a review that succeeded', () => {
    const folder = exportFolder();
    const out = mkdtempSync(join(tmpdir(), 'fss-trial-out-'));
    folders.push(out);
    const stubbed = stub(folder, [goodAnswer(), goodAnswer()]);
    chmodSync(folder, 0o500);
    let result;
    try {
      result = review(folder, stubbed.env, ['--out', out]);
    } finally {
      chmodSync(folder, 0o700);
    }
    expect(result.status).toBe(3);
    expect(String(result.stderr)).toContain('review stopped: E_CLEANUP');
    expect(exportGone(folder)).toBe(false);
    expect(readdirSync(out)).toEqual(['verdicts.json']);
  });
});

describe('TERF 5: an empty or short passphrase is refused before the key loads', () => {
  it('the reviewer\'s empty-passphrase PKCS#8 key: E_KEY on a blank line, the export removed', () => {
    const emptyPem = String(realKey().export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: '' }));
    expect(() => assertPassphraseRequired(emptyPem)).not.toThrow();
    expect(PASSPHRASE_MIN_CHARS).toBe(8);
    for (const typed of ['', '   ', 'seven77', ' seven77 ']) {
      expect(thrown(() => loadPrivateKey(emptyPem, typed)).code).toBe('E_KEY');
      expect(thrown(() => loadPrivateKey(pair.privateKey, typed)).code).toBe('E_KEY');
    }
    const folder = exportFolder(emptyPem);
    const result = review(folder, stub(folder, []).env, [], '');
    expect([result.status, String(result.stderr).split('\n')[0]]).toEqual([1, 'review stopped: E_KEY']);
    expect(readdirSync(folder)).toEqual(['key.pem']);
    expect(() => loadPrivateKey(pair.privateKey, PASSPHRASE)).not.toThrow();
  });
});

describe('TERF 6: the reporting type and the proposed value, from the export', () => {
  it('interested, not_interested and do_not_call give three distinguishable rows', () => {
    const rows = (['interested', 'not_interested', 'do_not_call'] as const).map(outcome => {
      const base = call('55555555-5555-4555-8555-555555555555', ['outcome']);
      const proposals = [{ key: 'outcome', kind: 'outcome', mode: 'apply', reason: 'r', params: { outcome, evidence: [] } }];
      const row = validateVerdicts({ verdicts: [entry('outcome')] }, { ...base, analysis: { ...base.analysis, proposals } } as ReviewCall).verdicts[0];
      expect(row?.report_type).toBe(acceptanceTypeOf(proposals[0] as unknown as CallProposal));
      return [row?.report_type, row?.proposed_value];
    });
    expect(rows).toEqual([
      ['outcome:interested', 'interested'],
      ['outcome:not_interested', 'not_interested'],
      ['stop', 'do_not_call'],
    ]);
  });

  it('the reporting type equals acceptanceTypeOf over every kind and outcome, and its list is exactly those values', () => {
    const all = new Set<string>();
    for (const kind of CALL_PROPOSAL_KINDS) {
      for (const outcome of kind === 'outcome' ? CALL_OUTCOMES : [undefined]) {
        const proposal = { key: kind, kind, mode: 'apply', reason: 'r', params: { outcome } };
        const type = acceptanceTypeOf(proposal as unknown as CallProposal);
        expect(reportTypeOf(proposal)).toBe(type);
        all.add(type);
      }
    }
    expect([...REPORT_TYPES].sort()).toEqual([...all].sort());
  });
});

describe('R4: a protected key needs its passphrase', () => {
  it('refuses a key that loads without a passphrase, the appended-marker case included, and a file of two PEM blocks', () => {
    const marker = ['-----BEGIN', 'ENCRYPTED PRIVATE', 'KEY-----'].join(' ');
    for (const pem of [plainPem(), `${plainPem()}\n${marker}\n`, `${pair.privateKey}\n${plainPem()}`]) {
      expect(thrown(() => assertPassphraseRequired(pem)).code).toBe('E_KEY_UNPROTECTED');
      const folder = exportFolder(pem);
      const result = review(folder, stub(folder, []).env, [], '');
      expect([result.status, String(result.stderr).split('\n')[0]]).toEqual([1, 'review stopped: E_KEY_UNPROTECTED']);
      expect(exportGone(folder)).toBe(true);
    }
    expect(() => assertPassphraseRequired(pair.privateKey)).not.toThrow();
  });
});

describe('the envelope (still standing)', () => {
  it('GCM: a 16-byte tag is required, the envelope is authenticated, and the parts must agree', () => {
    const folder = exportFolder();
    const parts = partsOf(folder);
    const key = realKey();
    expect(callsOf(decryptExport(parts, key))).toHaveLength(2);
    const [head, ...rest] = parts;
    if (head === undefined) throw new Error('no parts');
    const truncated = [{ ...head, tag: Buffer.from(head.tag, 'base64').subarray(0, 4).toString('base64') }, ...rest];
    expect(thrown(() => decryptExport(truncated, key)).code).toBe('E_DECRYPT');
    expect(thrown(() => decryptExport(parts.map(part => ({ ...part, exportId: 'ffffffffffffffff' })), key)).code).toBe('E_DECRYPT');
    const swapped = [{ ...head }, ...rest.slice(1, 2).map(part => ({ ...part, part: 2 })), ...rest.slice(0, 1).map(part => ({ ...part, part: 3 })), ...rest.slice(2)];
    expect(thrown(() => decryptExport(swapped, key)).code).toBe('E_DECRYPT');
    const lines = parts.map(part => JSON.stringify(part));
    expect(thrown(() => readExportParts([...lines.slice(0, -1), JSON.stringify({ ...parts[parts.length - 1], of: parts.length + 1 })].join('\n'))).code).toBe('E_INPUT_PARSE');
    expect(thrown(() => readExportParts(lines.slice(0, -1).join('\n'))).code).toBe('E_INPUT_PARSE');
    expect(readExportParts([...lines, lines[1]].join('\n'))).toHaveLength(parts.length);
  });
});

describe('the cost guard (still standing)', () => {
  it('bounds the input by the body\'s UTF-8 bytes and stops before the call that could pass the cap', async () => {
    const body = JSON.stringify(reviewRequestOf(CALLS[0] as ReviewCall));
    expect(inputTokenBound(body)).toBe(Buffer.byteLength(body, 'utf8'));
    let asked = 0;
    const invoke = async (): Promise<unknown> => {
      asked += 1;
      return await Promise.resolve(goodAnswer());
    };
    const bound = (Buffer.byteLength(body) * 3.3 + 4_000 * 16.5) / 1_000_000;
    const used = (900 * 3.3 + 120 * 16.5) / 1_000_000;
    const result = await reviewCalls({ calls: CALLS, invoke, capUsd: used + bound - 0.000_001 });
    expect(asked).toBe(1);
    expect(result).toMatchObject({ stoppedAtCap: true, reviewed: 1 });
    expect(result.spentUsd).toBeCloseTo(used, 8);
  });
});

describe('cleanup.sh (a manual sweep)', () => {
  it('removes exports, verdicts.json and older versions\' leftovers; it has no --all', () => {
    const folder = exportFolder();
    writeFileSync(join(folder, 'verdicts.json'), '{}');
    writeFileSync(join(folder, 'reasons-for-david.txt'), 'notes');
    const all = spawnSync('bash', [tool('cleanup.sh'), folder, '--all'], { encoding: 'utf8' });
    expect(all.status).toBe(2);
    expect(readdirSync(folder).sort()).toEqual(['key.pem', 'reasons-for-david.txt', 'trial-export.jsonl', 'verdicts.json']);
    const first = spawnSync('bash', [tool('cleanup.sh'), folder], { encoding: 'utf8' });
    expect(first.status).toBe(0);
    expect(readdirSync(folder)).toEqual(['key.pem']);
    expect(readFileSync(tool('cleanup.sh'), 'utf8')).not.toContain('--all');
  });
});
