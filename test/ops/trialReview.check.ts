import { spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { encryptTrialExport, readTrialExportPublicKey } from '../../apps/worker/src/tools/fss/trialExport.ts';
import { schemaProblems } from '../../packages/domain/test/support/structuredOutputsSchema.ts';
import {
  REVIEW_MODEL,
  VERDICT_SCHEMA,
  callsOf,
  decryptExport,
  readExportParts,
  reviewCalls,
  reviewRequestOf,
  transcriptRuns,
  quotedRunCount,
  validateVerdicts,
  type ReviewCall,
} from '../../tools/trial-review/lib.mjs';
import { repositoryPath } from './support/repository.ts';

/**
 * Slice S3T-E, Part B: `tools/trial-review/` (decrypt, review, cleanup), run as David runs them,
 * with a stubbed Bedrock client (`FSS_TRIAL_REVIEW_STUB`, a module the test writes). No request
 * leaves the machine. Covers: the round trip from the export's envelope through decrypt.mjs (the
 * passphrase on stdin, never an argument; the file 0600), the schema walker, the answer's
 * validation, the cost cap (stops before the call that could pass it), the no-quote check (a
 * reason repeating 8 words of a transcript fails the run and prints nothing), and the cleanup on
 * success and on failure, and `--keep`.
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
      proposals: keys.map(key => ({ key, kind: key, mode: 'apply', reason: 'From the call.', params: { evidence: [{ line: 2, side: 'them', start: 5, end: 9, quote: 'a short demo next week' }] } })),
    },
    decisions: [{ analysisId: '33333333-3333-4333-8333-333333333333', key: 'outcome', type: 'outcome:interested', result: 'unchanged', at: '2026-10-02T15:05:00.000Z' }],
    corrections: [],
    loggedOutcome: { outcome: 'interested', occurredAt: '2026-10-02T15:05:00.000Z' },
  };
}

const CALLS = [call('55555555-5555-4555-8555-555555555555'), call('66666666-6666-4666-8666-666666666666')];
const exported = { format: 'fss.trial-export.v1', since: '2026-10-02T07:14:00.000Z', workspaces: [{ workspaceId: '11111111-1111-4111-8111-111111111111', calls: CALLS }] };

const goodAnswer = (keys: readonly string[] = ['outcome', 'buying_signal'], reason = 'Line 2 asks for a demo, which supports it.') => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({ verdicts: keys.map(key => ({ key, verdict: 'correct', category: null, reason, decisionMatchesEvidence: key === 'outcome' ? 'yes' : 'no_decision' })) }),
    },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 900, output_tokens: 120 },
});

/** A folder holding an export as the ops helper prints it (indented, among other log lines). */
function exportFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'fss-trial-review-'));
  folders.push(folder);
  const key = readTrialExportPublicKey(Buffer.from(pair.publicKey).toString('base64'));
  if (!key.ok) throw new Error(key.reason);
  const lines = encryptTrialExport(Buffer.from(JSON.stringify(exported)), key.key, 2_000);
  writeFileSync(join(folder, 'trial-export.jsonl'), ['operations: log stream …', ...lines.map(line => `  ${line}`), '  {"exported":2}', ''].join('\n'));
  return folder;
}

function decrypt(folder: string): ReturnType<typeof spawnSync> {
  return spawnSync(node, [tool('decrypt.mjs'), join(folder, 'trial-export.jsonl'), join(folder, 'key.pem')], { input: `${PASSPHRASE}\n`, encoding: 'utf8' });
}

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
  if (answer === undefined || answer === 'throw') throw new Error('stubbed Bedrock failure');
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

function prepared(): string {
  const folder = exportFolder();
  writeFileSync(join(folder, 'key.pem'), pair.privateKey);
  const result = decrypt(folder);
  expect(result.status, String(result.stderr)).toBe(0);
  return folder;
}

const review = (folder: string, env: NodeJS.ProcessEnv, extra: readonly string[] = []) =>
  spawnSync(node, [tool('review.mjs'), folder, ...extra], { env, encoding: 'utf8' });

const decryptedGone = (folder: string): boolean => !existsSync(join(folder, 'trial-calls.json')) && !existsSync(join(folder, 'trial-export.jsonl'));

describe('the envelope and decrypt.mjs', () => {
  it('round trip: parts read from the indented log, the passphrase from stdin, the calls written 0600 and nothing printed of them', () => {
    const folder = exportFolder();
    writeFileSync(join(folder, 'key.pem'), pair.privateKey);
    const text = readFileSync(join(folder, 'trial-export.jsonl'), 'utf8');
    const parts = readExportParts(text);
    expect(parts.length).toBeGreaterThan(1);
    const result = decrypt(folder);
    expect(result.status, String(result.stderr)).toBe(0);
    const written = join(folder, 'trial-calls.json');
    expect(statSync(written).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(written, 'utf8'))).toEqual(exported);
    expect(`${String(result.stdout)}${String(result.stderr)}`).not.toContain('evaluating');
    expect(String(result.stdout)).toContain('"decrypted":2');
  });

  it('a wrong passphrase fails without writing anything', () => {
    const folder = exportFolder();
    writeFileSync(join(folder, 'key.pem'), pair.privateKey);
    const result = spawnSync(node, [tool('decrypt.mjs'), join(folder, 'trial-export.jsonl'), join(folder, 'key.pem')], { input: 'wrong\n', encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(existsSync(join(folder, 'trial-calls.json'))).toBe(false);
  });

  it('decryptExport refuses a tampered ciphertext (the GCM tag)', () => {
    const folder = exportFolder();
    const parts = readExportParts(readFileSync(join(folder, 'trial-export.jsonl'), 'utf8'));
    const last = parts[parts.length - 1];
    if (last === undefined) throw new Error('no parts');
    const flipped = last.ciphertext.startsWith('A') ? `B${last.ciphertext.slice(1)}` : `A${last.ciphertext.slice(1)}`;
    const tampered = [...parts.slice(0, -1), { ...last, ciphertext: flipped }];
    const key = generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey;
    expect(() => decryptExport(parts, key)).toThrow();
    const real = createPrivateKey({ key: pair.privateKey, passphrase: PASSPHRASE });
    expect(callsOf(decryptExport(parts, real))).toHaveLength(2);
    expect(() => decryptExport(tampered, real)).toThrow();
  });
});

describe('the request and the answer', () => {
  it('the verdict schema keeps the structured-outputs rules', () => {
    expect(schemaProblems(VERDICT_SCHEMA)).toEqual([]);
    const request = reviewRequestOf(CALLS[0] as ReviewCall);
    expect(schemaProblems((request['output_config'] as { format: { schema: unknown } }).format.schema)).toEqual([]);
    expect(request).toMatchObject({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 4_000 });
    expect(REVIEW_MODEL).toEqual({ inferenceProfileId: 'us.anthropic.claude-sonnet-4-6', foundationModelId: 'anthropic.claude-sonnet-4-6', region: 'us-east-1', profile: 'default' });
  });

  it('validates every verdict: each key once, categories only for incorrect, reasons at most 200 characters', () => {
    const one = CALLS[0] as ReviewCall;
    const ok = JSON.parse((goodAnswer().content[0] as { text: string }).text) as { verdicts: Record<string, unknown>[] };
    expect(validateVerdicts(ok, one)).toHaveLength(2);
    const bad = (patch: (verdicts: Record<string, unknown>[]) => unknown) => () => validateVerdicts({ verdicts: patch(structuredClone(ok.verdicts)) }, one);
    expect(bad(v => v.slice(0, 1))).toThrow(/no verdict/u);
    expect(bad(v => [...v, v[0]])).toThrow(/twice/u);
    expect(bad(v => v.map(e => ({ ...e, category: 'wrong_value' })))).toThrow(/only an incorrect/u);
    expect(bad(v => v.map(e => ({ ...e, verdict: 'incorrect' })))).toThrow(/no category/u);
    expect(bad(v => v.map(e => ({ ...e, reason: 'x'.repeat(201) })))).toThrow(/200/u);
    expect(bad(v => v.map(e => ({ ...e, key: 'park' })))).toThrow(/key the call does not have/u);
    expect(bad(v => v.map(e => ({ ...e, extra: 1 })))).toThrow(/wrong fields/u);
  });
});

describe('the cost guard', () => {
  it('stops before the call that could pass the cap, and counts what Bedrock reports', async () => {
    let asked = 0;
    const invoke = async (): Promise<unknown> => {
      asked += 1;
      return await Promise.resolve(goodAnswer());
    };
    const body = JSON.stringify(reviewRequestOf(CALLS[0] as ReviewCall));
    // One call's bound: ceil(bytes/3) input tokens and the 4,000-token maximum output.
    const bound = (Math.ceil(Buffer.byteLength(body) / 3) * 3.3 + 4_000 * 16.5) / 1_000_000;
    const used = (900 * 3.3 + 120 * 16.5) / 1_000_000;
    const result = await reviewCalls({ calls: CALLS, invoke, capUsd: used + bound - 0.000_001 });
    expect(asked).toBe(1);
    expect(result).toMatchObject({ stoppedAtCap: true, reviewed: 1 });
    expect(result.spentUsd).toBeCloseTo(used, 8);
    const all = await reviewCalls({ calls: CALLS, invoke, capUsd: 3 });
    expect(all).toMatchObject({ stoppedAtCap: false, reviewed: 2 });
  });

  it('review.mjs with a cap below the first call asks Bedrock nothing, exits 4, and cleans up', () => {
    const folder = prepared();
    const stubbed = stub(folder, [goodAnswer()]);
    const result = review(folder, stubbed.env, ['--cap-usd', '0.01']);
    expect(result.status, String(result.stderr)).toBe(4);
    expect(stubbed.asked()).toBe(0);
    expect(String(result.stdout)).toMatch(/stop: call 1 of 2 could cost up to \$/u);
    expect(decryptedGone(folder)).toBe(true);
  });
});

describe('review.mjs', () => {
  it('reviews every call, writes verdicts.json, prints ids, kinds, verdicts and reasons only, and cleans up', () => {
    const folder = prepared();
    const stubbed = stub(folder, [goodAnswer(), goodAnswer()]);
    const result = review(folder, stubbed.env);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(stubbed.asked()).toBe(2);
    const verdicts = JSON.parse(readFileSync(join(folder, 'verdicts.json'), 'utf8')) as { verdicts: unknown[]; model: string };
    expect(verdicts.model).toBe('us.anthropic.claude-sonnet-4-6');
    expect(verdicts.verdicts).toHaveLength(4);
    expect(String(result.stdout)).toContain('55555555 | outcome | outcome | correct | - | yes | Line 2 asks for a demo');
    expect(String(result.stdout)).not.toContain('evaluating');
    expect(decryptedGone(folder)).toBe(true);
    expect(readdirSync(folder).sort()).toEqual(['key.pem', 'verdicts.json']);
  });

  it('the no-quote check: a reason repeating 8 words of a transcript fails the run, writes and prints nothing of it, and cleans up', () => {
    const folder = prepared();
    const leaky = goodAnswer(['outcome', 'buying_signal'], 'They said three tools this quarter and would like a short demo.');
    expect(quotedRunCount('three tools this quarter and would like a short demo', transcriptRuns(CALLS))).toBeGreaterThan(0);
    const stubbed = stub(folder, [goodAnswer(), leaky]);
    const result = review(folder, stubbed.env);
    expect(result.status).toBe(3);
    expect(String(result.stderr)).toContain('repeats transcript wording');
    expect(`${String(result.stdout)}${String(result.stderr)}`).not.toContain('three tools');
    expect(existsSync(join(folder, 'verdicts.json'))).toBe(false);
    expect(decryptedGone(folder)).toBe(true);
  });

  it('an answer that fails validation stops the run (no retry, no other provider) and cleans up', () => {
    const folder = prepared();
    const stubbed = stub(folder, [goodAnswer(['outcome'])]);
    const result = review(folder, stubbed.env);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain('review stopped: 1 suggestion(s) have no verdict');
    expect(stubbed.asked()).toBe(1);
    expect(decryptedGone(folder)).toBe(true);
  });

  it('a Bedrock error stops the run and cleans up; --keep keeps the files', () => {
    const failing = prepared();
    const first = stub(failing, ['throw']);
    const result = review(failing, first.env);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain('review stopped: stubbed Bedrock failure');
    expect(first.asked()).toBe(1);
    expect(decryptedGone(failing)).toBe(true);

    const kept = prepared();
    const second = stub(kept, ['throw']);
    expect(review(kept, second.env, ['--keep']).status).toBe(1);
    expect(existsSync(join(kept, 'trial-calls.json'))).toBe(true);
    const cleaned = spawnSync('bash', [tool('cleanup.sh'), kept], { encoding: 'utf8' });
    expect(cleaned.status).toBe(0);
    expect(String(cleaned.stdout)).toContain('removed 2 file(s)');
    expect(decryptedGone(kept)).toBe(true);
  });
});
