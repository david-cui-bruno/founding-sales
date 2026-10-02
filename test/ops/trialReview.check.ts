import { spawn, spawnSync } from 'node:child_process';
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
  ToolError,
  VERDICT_SCHEMA,
  foldForQuoteCheck,
  inputTokenBound,
  isProtectedPem,
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
  if (answer === 'hang') return await new Promise(resolve => setTimeout(resolve, 60_000));
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

/** The ToolError a call throws: its code and its fixed detail. */
function thrown(action: () => unknown): { readonly code: string; readonly detail: string } {
  try {
    action();
  } catch (error) {
    if (error instanceof ToolError) return { code: error.code, detail: error.detail };
    throw error;
  }
  throw new Error('nothing was thrown');
}

const realKey = () => createPrivateKey({ key: pair.privateKey, passphrase: PASSPHRASE });
const partsOf = (folder: string) => readExportParts(readFileSync(join(folder, 'trial-export.jsonl'), 'utf8'));

describe('the envelope and decrypt.mjs', () => {
  it('round trip: parts read from the indented log, the passphrase from stdin, the calls written 0600 and nothing printed of them', () => {
    const folder = exportFolder();
    writeFileSync(join(folder, 'key.pem'), pair.privateKey);
    expect(partsOf(folder).length).toBeGreaterThan(1);
    const result = decrypt(folder);
    expect(result.status, String(result.stderr)).toBe(0);
    const written = join(folder, 'trial-calls.json');
    expect(statSync(written).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(written, 'utf8'))).toEqual(exported);
    expect(`${String(result.stdout)}${String(result.stderr)}`).not.toContain('evaluating');
    expect(String(result.stdout)).toContain('"decrypted":2');
    // No temporary file is left beside it.
    expect(readdirSync(folder).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('a wrong passphrase fails with a code only, and removes a plaintext left from before', () => {
    const folder = exportFolder();
    writeFileSync(join(folder, 'key.pem'), pair.privateKey);
    writeFileSync(join(folder, 'trial-calls.json'), JSON.stringify(exported), { mode: 0o600 });
    const result = spawnSync(node, [tool('decrypt.mjs'), join(folder, 'trial-export.jsonl'), join(folder, 'key.pem')], { input: 'wrong\n', encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toBe('decrypt failed: E_KEY\n');
    expect(existsSync(join(folder, 'trial-calls.json'))).toBe(false);
    expect(readdirSync(folder).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a private key that is not passphrase-protected, before asking for anything', () => {
    const folder = exportFolder();
    writeFileSync(join(folder, 'key.pem'), realKey().export({ type: 'pkcs8', format: 'pem' }));
    const result = spawnSync(node, [tool('decrypt.mjs'), join(folder, 'trial-export.jsonl'), join(folder, 'key.pem')], { input: '\n', encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toBe('decrypt failed: E_KEY_UNPROTECTED\n');
    expect(existsSync(join(folder, 'trial-calls.json'))).toBe(false);
    expect(isProtectedPem(pair.privateKey)).toBe(true);
    // Assembled at run time, so no PEM header sits in the source (the secrets check).
    const header = (label: string): string => ['-----BEGIN', label, 'KEY-----'].join(' ');
    expect(isProtectedPem(`${header('RSA PRIVATE')}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,00\n`)).toBe(true);
    expect(isProtectedPem(`${header('PRIVATE')}\n`)).toBe(false);
  });

  it('a malformed export prints only a code, never its text', () => {
    const folder = exportFolder();
    writeFileSync(join(folder, 'key.pem'), pair.privateKey);
    writeFileSync(join(folder, 'trial-export.jsonl'), `{"v":1,"alg":"RSA-OAEP-256+A256GCM","exportId":"x","part":2,"of":2,"note":"${SPOKEN}"}\n`);
    const result = decrypt(folder);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toBe('decrypt failed: E_INPUT_PARSE\n');
  });

  it('GCM: a 16-byte tag is required, the envelope is authenticated, and the parts must agree', () => {
    const folder = exportFolder();
    const parts = partsOf(folder);
    const key = realKey();
    expect(callsOf(decryptExport(parts, key))).toHaveLength(2);
    const [head, ...rest] = parts;
    if (head === undefined) throw new Error('no parts');
    // A truncated tag (4 bytes): refused, though GCM alone would accept it.
    const truncated = [{ ...head, tag: Buffer.from(head.tag, 'base64').subarray(0, 4).toString('base64') }, ...rest];
    expect(thrown(() => decryptExport(truncated, key)).code).toBe('E_DECRYPT');
    // Relabelled consistently (another export id): every part's AAD fails.
    const relabelled = parts.map(part => ({ ...part, exportId: 'ffffffffffffffff' }));
    expect(thrown(() => decryptExport(relabelled, key)).code).toBe('E_DECRYPT');
    // Two parts swapped and renumbered to match: their AAD names the other index.
    const swapped = [{ ...head }, ...rest.slice(1, 2).map(part => ({ ...part, part: 2 })), ...rest.slice(0, 1).map(part => ({ ...part, part: 3 })), ...rest.slice(2)];
    expect(thrown(() => decryptExport(swapped, key)).code).toBe('E_DECRYPT');
    // An inconsistent total on a later part: refused before decryption.
    const lines = parts.map(part => JSON.stringify(part));
    const inconsistent = [...lines.slice(0, -1), JSON.stringify({ ...parts[parts.length - 1], of: parts.length + 1 })].join('\n');
    expect(thrown(() => readExportParts(inconsistent)).code).toBe('E_INPUT_PARSE');
    // A missing part, and two different parts claiming one index.
    expect(thrown(() => readExportParts(lines.slice(0, -1).join('\n'))).code).toBe('E_INPUT_PARSE');
    expect(thrown(() => readExportParts([...lines, JSON.stringify({ ...parts[1], ciphertext: 'AAAA' })].join('\n'))).code).toBe('E_INPUT_PARSE');
    // An identical repeat (the same log line twice) is tolerated.
    expect(readExportParts([...lines, lines[1]].join('\n'))).toHaveLength(parts.length);
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

  it('validates every verdict: each key once, categories only for incorrect, reasons at most 200 printable ASCII characters', () => {
    const one = CALLS[0] as ReviewCall;
    const ok = JSON.parse((goodAnswer().content[0] as { text: string }).text) as { verdicts: Record<string, unknown>[] };
    expect(validateVerdicts(ok, one)).toHaveLength(2);
    const bad = (patch: (verdicts: Record<string, unknown>[]) => unknown) => thrown(() => validateVerdicts({ verdicts: patch(structuredClone(ok.verdicts)) }, one));
    expect(bad(v => v.slice(0, 1))).toEqual({ code: 'E_SCHEMA', detail: '1 suggestion(s) have no verdict' });
    expect(bad(v => [...v, v[0]]).detail).toMatch(/twice/u);
    expect(bad(v => v.map(e => ({ ...e, category: 'wrong_value' }))).detail).toMatch(/only an incorrect/u);
    expect(bad(v => v.map(e => ({ ...e, verdict: 'incorrect' }))).detail).toMatch(/no category/u);
    expect(bad(v => v.map(e => ({ ...e, reason: 'x'.repeat(201) }))).detail).toMatch(/200/u);
    expect(bad(v => v.map(e => ({ ...e, key: 'park' }))).detail).toMatch(/key the call does not have/u);
    expect(bad(v => v.map(e => ({ ...e, extra: 1 }))).detail).toMatch(/wrong fields/u);
    // Refused, never cleaned: invisible and look-alike characters, after NFKC.
    for (const reason of ['Line 2\u200basks for a demo.', 'Line 2 asks\u200d for a demo.', 'Line 2 \u0430sks for a demo.', 'Line 2 asks for a de\u00admo.']) {
      expect(bad(v => v.map(e => ({ ...e, reason }))).code).toBe('E_OUTPUT_CHARS');
    }
    // NBSP folds to a space under NFKC, so it passes here; the quote check folds it too.
    expect(validateVerdicts({ verdicts: ok.verdicts.map(e => ({ ...e, reason: 'Line 2\u00a0asks.' })) }, one)).toHaveLength(2);
  });
});

describe('the no-quote check', () => {
  const runs = transcriptRuns(CALLS);
  const words = SPOKEN.split(' ').slice(2, 9);
  it('folds invisible characters, marks, spaces and punctuation before comparing six words or thirty letters', () => {
    expect(foldForQuoteCheck('De\u0301mo\u200b\u00ad')).toBe('demo');
    const variants = [
      words.join(' '),
      words.join('\u200b '),
      words.join(' ').replace(/o/gu, 'o\u200b'),
      words.join(' ').replace(/e/gu, 'e\u200d'),
      words.join('\u00a0'),
      words.join(' ').replace(/a/gu, 'a\u00ad'),
      words.join('.'),
      words.join(' ').replace(/(\w)(\w)/gu, '$1-$2'),
      words.join(' ').toUpperCase(),
    ];
    for (const variant of variants) expect(quotedRunCount(`It says ${variant} there.`, runs), JSON.stringify(variant)).toBeGreaterThan(0);
    expect(quotedRunCount('Line 2 asks for a demo, which supports it.', runs)).toBe(0);
  });
});

describe('the cost guard', () => {
  it('bounds the input by the body\'s UTF-8 bytes', () => {
    const body = JSON.stringify(reviewRequestOf(CALLS[0] as ReviewCall));
    expect(inputTokenBound(body)).toBe(Buffer.byteLength(body, 'utf8'));
    expect(inputTokenBound('\u00e9')).toBe(2);
  });

  it('stops before the call that could pass the cap, and counts what Bedrock reports', async () => {
    let asked = 0;
    const invoke = async (): Promise<unknown> => {
      asked += 1;
      return await Promise.resolve(goodAnswer());
    };
    const body = JSON.stringify(reviewRequestOf(CALLS[0] as ReviewCall));
    const bound = (Buffer.byteLength(body) * 3.3 + 4_000 * 16.5) / 1_000_000;
    const used = (900 * 3.3 + 120 * 16.5) / 1_000_000;
    const result = await reviewCalls({ calls: CALLS, invoke, capUsd: used + bound - 0.000_001 });
    expect(asked).toBe(1);
    expect(result).toMatchObject({ stoppedAtCap: true, reviewed: 1 });
    expect(result.spentUsd).toBeCloseTo(used, 8);
    const all = await reviewCalls({ calls: CALLS, invoke, capUsd: 3 });
    expect(all).toMatchObject({ stoppedAtCap: false, reviewed: 2 });
  });

  it('review.mjs with a cap below the first call asks Bedrock nothing, exits 4, reports the bound, and cleans up', () => {
    const folder = prepared();
    const stubbed = stub(folder, [goodAnswer()]);
    const result = review(folder, stubbed.env, ['--cap-usd', '0.01']);
    expect(result.status, String(result.stderr)).toBe(4);
    expect(stubbed.asked()).toBe(0);
    expect(String(result.stdout)).toMatch(/stop: call 1 of 2 could cost up to \$[\d.]+ \(\d+ input tokens at most, 4000 output\)/u);
    expect(decryptedGone(folder)).toBe(true);
  });
});

describe('review.mjs', () => {
  it('reviews every call, writes verdicts.json 0600 (even over an old 0644 file), prints ids, kinds, verdicts and reasons only, and cleans up', () => {
    const folder = prepared();
    writeFileSync(join(folder, 'verdicts.json'), '{}', { mode: 0o644 });
    const stubbed = stub(folder, [goodAnswer(), goodAnswer()]);
    const result = review(folder, stubbed.env);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(stubbed.asked()).toBe(2);
    const verdicts = JSON.parse(readFileSync(join(folder, 'verdicts.json'), 'utf8')) as { verdicts: unknown[]; model: string };
    expect(statSync(join(folder, 'verdicts.json')).mode & 0o777).toBe(0o600);
    expect(verdicts.model).toBe('us.anthropic.claude-sonnet-4-6');
    expect(verdicts.verdicts).toHaveLength(4);
    expect(String(result.stdout)).toContain('55555555 | outcome | outcome | correct | - | yes | Line 2 asks for a demo');
    expect(String(result.stdout)).not.toContain('evaluating');
    expect(decryptedGone(folder)).toBe(true);
    expect(readdirSync(folder).sort()).toEqual(['key.pem', 'verdicts.json']);
  });

  it('the no-quote check: a reason repeating six words of a transcript fails the run, writes and prints nothing of it, and cleans up', () => {
    const folder = prepared();
    const leaky = goodAnswer(['outcome', 'buying_signal'], 'They mention three tools this quarter and would like it.');
    const stubbed = stub(folder, [goodAnswer(), leaky]);
    const result = review(folder, stubbed.env);
    expect(result.status).toBe(3);
    expect(String(result.stderr)).toBe('review stopped: E_QUOTE\n');
    expect(String(result.stdout)).not.toContain('three tools');
    expect(existsSync(join(folder, 'verdicts.json'))).toBe(false);
    expect(decryptedGone(folder)).toBe(true);
  });

  it('a zero-width space inside a quote is refused (E_OUTPUT_CHARS), and punctuation inserted between letters is still caught (E_QUOTE)', () => {
    const zw = prepared();
    const hidden = goodAnswer(['outcome', 'buying_signal'], 'They mention three tools this qu\u200barter and would like it.');
    const zwResult = review(zw, stub(zw, [hidden]).env);
    expect(String(zwResult.stderr)).toBe('review stopped: E_OUTPUT_CHARS\n');
    expect(zwResult.status).toBe(3);
    const dotted = prepared();
    const punctuated = goodAnswer(['outcome', 'buying_signal'], 'Per line 2: t.h.r.e.e.t.o.o.l.s.t.h.i.s.q.u.a.r.t.e.r.a.n.d.w.o.u.l.d.l.i.k.e.');
    const result = review(dotted, stub(dotted, [punctuated, goodAnswer()]).env);
    expect(result.status).toBe(3);
    expect(String(result.stderr)).toBe('review stopped: E_QUOTE\n');
    expect(decryptedGone(zw) && decryptedGone(dotted)).toBe(true);
  });

  it('an answer that fails validation stops the run with a code only (no retry, no other provider) and cleans up', () => {
    const folder = prepared();
    const stubbed = stub(folder, [goodAnswer(['outcome'])]);
    const result = review(folder, stubbed.env);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toBe('review stopped: E_SCHEMA\n');
    expect(stubbed.asked()).toBe(1);
    expect(decryptedGone(folder)).toBe(true);
  });

  it('malformed calls holding transcript-like text: stderr has only the code', () => {
    const folder = prepared();
    writeFileSync(join(folder, 'trial-calls.json'), `{"workspaces": [{"calls": [ "${SPOKEN}" ,, ]}`);
    const result = review(folder, stub(folder, []).env);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toBe('review stopped: E_INPUT_PARSE\n');
    expect(String(result.stdout)).not.toContain('evaluating');
    expect(decryptedGone(folder)).toBe(true);
  });

  it('a Bedrock error stops the run with a code only (its message is never printed) and cleans up; --keep keeps the files', () => {
    const failing = prepared();
    const first = stub(failing, ['throw']);
    const result = review(failing, first.env);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toBe('review stopped: E_BEDROCK\n');
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

  it('bad arguments (--cap-usd 0) still clean up', () => {
    const folder = prepared();
    const result = review(folder, stub(folder, []).env, ['--cap-usd', '0']);
    expect(result.status).toBe(2);
    expect(String(result.stderr)).toBe('review stopped: E_ARGS\n');
    expect(decryptedGone(folder)).toBe(true);
  });

  it('Ctrl-C (SIGINT) during a Bedrock request cleans up and exits 130', async () => {
    const folder = prepared();
    const stubbed = stub(folder, ['hang']);
    const child = spawn(node, [tool('review.mjs'), folder], { env: stubbed.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    // Wait until the request is in flight.
    for (let waited = 0; stubbed.asked() === 0 && waited < 10_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    expect(stubbed.asked()).toBe(1);
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    expect(stderr).toBe('review stopped: E_INTERRUPTED\n');
    expect(decryptedGone(folder)).toBe(true);
  });
});
