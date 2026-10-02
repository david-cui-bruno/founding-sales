import { constants, createDecipheriv, createPrivateKey, generateKeyPairSync, privateDecrypt, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeCallTrial } from '@fss/domain/calls/trialReport.ts';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { answer, lines } from '@fss/domain/test/calls/analysisFixtures.ts';
import { apply, createApplyWorld, type Analysed, type ApplyWorld } from '@fss/domain/test/calls/support/applyWorld.ts';
import { main } from '../src/tools/fss.ts';
import { COMMAND_DEPENDENCIES, parseFssCommand } from '../src/tools/fss/commands.ts';
import { TRIAL_EXPORT_ALG, TRIAL_EXPORT_LINE_LIMIT_BYTES, encryptTrialExport, readTrialExportPublicKey, type TrialExportPart } from '../src/tools/fss/trialExport.ts';

/**
 * `fss admin trial export` on real PostgreSQL (slice S3T-E): the calls `GET /calls/trial` counts,
 * oldest first, encrypted to a public key; decrypted here with the private key.
 *
 * Fictional throughout: "Dana Example", `example.test`, 555-01XX numbers.
 */

let world: ApplyWorld;
let url = '';
let first: Analysed;
let second: Analysed;
let firstFirmName = '';

const keys = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const publicB64 = Buffer.from(keys.publicKey).toString('base64');

async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const printed: string[] = [];
  const errors: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    errors.push(String(chunk));
    return true;
  });
  try {
    return { code: await main(argv, { DATABASE_URL: url }), stdout: printed.join(''), stderr: errors.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

function decrypt(stdout: string, privateKey: KeyObject = createPrivateKey(keys.privateKey)): unknown {
  const parts = stdout
    .split('\n')
    .filter(line => line.startsWith('{"v":1'))
    .map(line => JSON.parse(line) as TrialExportPart);
  const head = parts[0];
  if (head?.wrappedKey === undefined || head.iv === undefined || head.tag === undefined) throw new Error('no head part');
  const contentKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(head.wrappedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(head.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(head.tag, 'base64'));
  const ciphertext = Buffer.from(
    parts
      .sort((left, right) => left.part - right.part)
      .map(part => part.ciphertext)
      .join(''),
    'base64',
  );
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

type Exported = {
  format: string;
  workspaces: {
    workspaceId: string;
    calls: {
      callSessionId: string;
      contactId: string | null;
      transcript: { turns: { line: number; speaker: string; text: string }[] };
      analysis: { analysisId: string; proposals: { key: string; kind: string; params: Record<string, unknown> }[] };
      decisions: { key: string; result: string }[];
      corrections: { key: string; reason: string; from: unknown; to: unknown }[];
      loggedOutcome: { outcome: string } | null;
    }[];
  }[];
};

beforeAll(async () => {
  world = await createApplyWorld();
  await world.setTranscription(true);
  const clusterUrl = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  clusterUrl.pathname = `/${world.database.name}`;
  url = clusterUrl.toString();

  // The first call: a demo request, the contact named, an address and a number spoken.
  const firm = await world.newFirm();
  firstFirmName = (await world.session.query<{ name: string }>('SELECT name FROM firms WHERE id = $1', [firm.firmId])).rows[0]?.name ?? '';
  const spoken = lines(
    ['Y', `Hi Dana, this is David from Callie. Is this ${firstFirmName}?`],
    ['T', "We're evaluating tools. Can you show us a demo?"],
    ['T', 'Email me at dana.ops@example.test or call 401-555-0142.'],
  );
  first = await world.analyse(
    await world.placeCall(firm, spoken),
    answer({
      summary: 'You reached Dana. She asked for a demo.',
      interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
    }),
  );
  const applied = await apply(world, first, ['outcome']);
  if (!applied.ok) throw new Error(JSON.stringify(applied));
  // A later correction of the applied outcome (the S3X row's shape).
  await world.session.query(
    `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
     VALUES ($1, 'user', $2, 'call.proposal_corrected', 'call_analysis', $3, $4::jsonb)`,
    [
      world.seeded.alpha.workspaceId,
      world.seeded.alpha.salesperson.userId,
      first.analysisId,
      JSON.stringify({ analysisId: first.analysisId, callSessionId: first.sessionId, key: 'outcome', priorResult: 'unchanged', reason: 'new_information', correctedFrom: 'interested', correctedTo: 'callback_requested' }),
    ],
  );

  // The second call: a wrong number, and another number given.
  const other = lines(['Y', 'Hi, is this the office?'], ['T', 'Wrong number. Try 401 555 0199 instead.']);
  second = await world.analyse(
    await world.placeCall(await world.newFirm(), other),
    answer({ summary: 'A wrong number.', wrong_number: { is_wrong: true, quote: 'Wrong number. Try 401 555 0199 instead.', line: 2, other_number_given: '401 555 0199' } }),
  );

  // Not counted: a 19 s call, never analysed.
  await world.placeCall(await world.newFirm(), lines(['T', 'Not now, thanks.']), { statuses: [{ status: 'in-progress' }, { status: 'completed', seconds: 19 }], recordingSeconds: 19 });
});

afterAll(async () => {
  await world.drop();
});

const SINCE = '2026-01-01T00:00:00Z';

describe('fss admin trial export', () => {
  it('is a database command with a required public key', () => {
    expect(COMMAND_DEPENDENCIES['trial export']).toBe('database');
    const parsed = parseFssCommand(['admin', 'trial', 'export']);
    expect(parsed.ok).toBe(false);
  });

  it('round trip: the trial calls, oldest first, decrypted with the private key; one line about the content', async () => {
    const result = await run(['admin', 'trial', 'export', '--public-key-pem-b64', publicB64, '--since', SINCE]);
    expect(result.code, result.stderr).toBe(0);
    const printed = result.stdout.trim().split('\n');
    expect(printed[printed.length - 1]).toBe('{"exported":2}');
    for (const line of printed.slice(0, -1)) {
      expect(JSON.parse(line)).toMatchObject({ v: 1, alg: TRIAL_EXPORT_ALG });
      expect(Buffer.byteLength(line)).toBeLessThan(TRIAL_EXPORT_LINE_LIMIT_BYTES);
    }
    const exported = decrypt(result.stdout) as Exported;
    expect(exported.format).toBe('fss.trial-export.v1');
    const calls = exported.workspaces.flatMap(workspace => workspace.calls);

    // The selection is the trial read's: the analysed calls, oldest first.
    const trial = await computeCallTrial(world.admin(), { since: SINCE });
    expect(calls.map(entry => entry.callSessionId)).toEqual(trial.analysedCalls.map(entry => entry.callSessionId));
    expect(calls.map(entry => entry.callSessionId)).toEqual([first.sessionId, second.sessionId]);
    expect(trial.response.progress.analysed).toBe(2);

    const [one, two] = calls;
    expect(one?.transcript.turns.map(turn => turn.speaker)).toEqual(['You', 'Them', 'Them']);
    expect(one?.analysis.analysisId).toBe(first.analysisId);
    expect(one?.analysis.proposals.map(proposal => proposal.key).sort()).toEqual(['buying_signal', 'outcome']);
    expect(one?.decisions).toEqual([expect.objectContaining({ key: 'outcome', result: 'unchanged' })]);
    expect(one?.corrections).toEqual([expect.objectContaining({ key: 'outcome', reason: 'new_information', from: 'interested', to: 'callback_requested' })]);
    expect(one?.loggedOutcome?.outcome).toBe('interested');
    expect(one?.contactId).toBe(first.firm.contactId);
    expect(two?.analysis.proposals.find(proposal => proposal.kind === 'corrected_number')?.params['spokenNumber']).toBe('[phone]');
  });

  it('carries no audio, recording path, number, address or name; the transcript is redacted in place', async () => {
    const result = await run(['admin', 'trial', 'export', '--public-key-pem-b64', publicB64, '--since', SINCE]);
    const plaintext = JSON.stringify(decrypt(result.stdout));
    for (const absent of ['Dana', 'dana.ops@example.test', '401-555-0142', '401 555 0199', '/Recordings/', 'recording_path', 'recordingPath', firstFirmName, first.firm.e164]) {
      expect(plaintext).not.toContain(absent);
    }
    const exported = JSON.parse(plaintext) as Exported;
    const turns = exported.workspaces[0]?.calls[0]?.transcript.turns ?? [];
    expect(turns[0]?.text).toBe('Hi [contact], this is David from Callie. Is this [firm]?');
    expect(turns[1]?.text).toBe("We're evaluating tools. Can you show us a demo?");
    expect(turns[2]?.text).toBe('Email me at [email] or call [phone].');
  });

  it('logs nothing of the content: no transcript word, no id, on stdout or stderr', async () => {
    const result = await run(['admin', 'trial', 'export', '--public-key-pem-b64', publicB64, '--since', SINCE]);
    for (const absent of ['evaluating', 'demo', first.sessionId, second.sessionId, first.firm.firmId, first.analysisId]) {
      expect(result.stdout).not.toContain(absent);
      expect(result.stderr).not.toContain(absent);
    }
  });

  it('--max-calls takes the oldest; the default since is the 3a release', async () => {
    const one = await run(['admin', 'trial', 'export', '--public-key-pem-b64', publicB64, '--since', SINCE, '--max-calls', '1']);
    expect(one.stdout.trim().split('\n').pop()).toBe('{"exported":1}');
    expect((decrypt(one.stdout) as Exported).workspaces[0]?.calls.map(entry => entry.callSessionId)).toEqual([first.sessionId]);
    const defaulted = await run(['admin', 'trial', 'export', '--public-key-pem-b64', publicB64]);
    expect(defaulted.code).toBe(0);
    // These calls were placed now, after 2 Oct 07:14Z, so the default still counts them.
    expect(defaulted.stdout.trim().split('\n').pop()).toBe('{"exported":2}');
  });

  it('refuses a key under 3072 bits, a non-RSA key, garbage, and bad flags, printing nothing on stdout', async () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    for (const [argv, reason] of [
      [['--public-key-pem-b64', Buffer.from(weak.publicKey).toString('base64')], 'public_key_weak'],
      [['--public-key-pem-b64', Buffer.from(ec.publicKey).toString('base64')], 'public_key_weak'],
      [['--public-key-pem-b64', 'bm90IGEga2V5'], 'public_key_unreadable'],
      [['--public-key-pem-b64', publicB64, '--max-calls', '0'], 'max_calls_invalid'],
      [['--public-key-pem-b64', publicB64, '--since', 'yesterday'], 'since_invalid'],
    ] as const) {
      const result = await run(['admin', 'trial', 'export', ...argv]);
      expect(result.code).toBe(20);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(reason);
    }
    expect(readTrialExportPublicKey(Buffer.from(weak.publicKey).toString('base64'))).toMatchObject({ ok: false, reason: 'public_key_weak' });
  });

  it('is read only: the transaction is rolled back and nothing is written', async () => {
    const count = async () => (await world.session.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')).rows[0]?.n ?? 0;
    const before = await count();
    expect((await run(['admin', 'trial', 'export', '--public-key-pem-b64', publicB64, '--since', SINCE])).code).toBe(0);
    expect(await count()).toBe(before);
  });
});

describe('the envelope', () => {
  it('splits a large export into numbered parts, each under the line limit, the key on the first; they reassemble', () => {
    const key = readTrialExportPublicKey(publicB64);
    if (!key.ok) throw new Error(key.reason);
    const plaintext = Buffer.from(JSON.stringify({ filler: 'x'.repeat(300_000) }));
    const lines = encryptTrialExport(plaintext, key.key);
    expect(lines.length).toBeGreaterThan(20);
    const parts = lines.map(line => JSON.parse(line) as TrialExportPart);
    expect(parts.map(part => part.part)).toEqual(parts.map((_, index) => index + 1));
    expect(new Set(parts.map(part => part.of))).toEqual(new Set([parts.length]));
    expect(new Set(parts.map(part => part.exportId)).size).toBe(1);
    expect(parts.filter(part => part.wrappedKey !== undefined)).toHaveLength(1);
    for (const line of lines) expect(Buffer.byteLength(line)).toBeLessThan(TRIAL_EXPORT_LINE_LIMIT_BYTES);
    expect(decrypt(lines.join('\n'))).toEqual({ filler: 'x'.repeat(300_000) });
    // A small export is one line.
    expect(encryptTrialExport(Buffer.from('{}'), key.key)).toHaveLength(1);
  });
});
