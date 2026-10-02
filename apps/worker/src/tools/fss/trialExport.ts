import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes, type KeyObject } from 'node:crypto';
import { CALL_TRIAL_DEFAULT_SINCE, instant } from '@fss/contracts';
import { buildTrialExport, type TrialExportPayload } from '@fss/domain/calls/trialExport.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { AdminInvocation, AdminOutcome } from './admin.ts';

/**
 * `fss admin trial export` (slice S3T-E; David's approval of 2 October 2026): the ten-call
 * trial, encrypted to David's public key, for a review he runs on his own Mac through AWS
 * Bedrock (`tools/trial-review/`). Read only: one READ ONLY transaction, rolled back.
 *
 * What is selected is what `GET /calls/trial` counts toward ten (`computeCallTrial`) in ONE
 * workspace (`--workspace <slug>`, required when the database holds more than one), oldest
 * first, at most `--max-calls` (default 12); what each call carries is `buildTrialExport`'s.
 *
 * ## The envelope
 *
 * A random 256-bit key encrypts the JSON with AES-256-GCM (a 96-bit IV, the 128-bit tag); the
 * key is wrapped with RSA-OAEP-SHA256 to the supplied public key, which must be RSA of at least
 * 3072 bits. The plaintext exists in this process's memory only: no file, no log line.
 *
 * Printed on stdout, which the operations task's log keeps:
 *
 *   * `{v:1, alg, exportId, part, of, wrappedKey?, iv, tag, ciphertext}` — the first part
 *     carries the wrapped key; each part is its own AES-256-GCM message over a slice of the
 *     plaintext (its own IV, a 16-byte tag, and `{v, alg, exportId, part, of}` as AAD);
 *   * then the command's answer, `{exported: n}` — the one line about the content.
 *
 * Each line stays under `TRIAL_EXPORT_LINE_LIMIT_BYTES`. CloudWatch keeps events up to
 * 256 KB, but the container runtime splits a log line at 16 KB before CloudWatch sees it, so
 * the parts are cut well under that.
 */

export const TRIAL_EXPORT_ALG = 'RSA-OAEP-256+A256GCM';
export const TRIAL_EXPORT_MINIMUM_RSA_BITS = 3072;
export const TRIAL_EXPORT_DEFAULT_MAX_CALLS = 12;
export const TRIAL_EXPORT_MAX_CALLS = 50;
/** Under the runtime's 16 KB line split, and so under CloudWatch's 256 KB event limit. */
export const TRIAL_EXPORT_LINE_LIMIT_BYTES = 15_000;

export interface TrialExportPart {
  readonly v: 1;
  readonly alg: typeof TRIAL_EXPORT_ALG;
  readonly exportId: string;
  readonly part: number;
  readonly of: number;
  /** On the first part only. */
  readonly wrappedKey?: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export type PublicKeyCheck = { readonly ok: true; readonly key: KeyObject } | { readonly ok: false; readonly reason: string; readonly detail: string };

/** The supplied key, if it is an RSA public key of at least 3072 bits. */
export function readTrialExportPublicKey(pemBase64: string | undefined): PublicKeyCheck {
  if (pemBase64 === undefined || pemBase64.trim() === '') return { ok: false, reason: 'public_key_missing', detail: 'pass --public-key-pem-b64 <base64 of the PEM>' };
  let key: KeyObject;
  try {
    key = createPublicKey(Buffer.from(pemBase64.trim(), 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'public_key_unreadable', detail: '--public-key-pem-b64 is not the base64 of a PEM public key' };
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== 'rsa' || bits < TRIAL_EXPORT_MINIMUM_RSA_BITS) {
    return {
      ok: false,
      reason: 'public_key_weak',
      detail: `the export is wrapped with RSA-OAEP-SHA256 to an RSA key of at least ${String(TRIAL_EXPORT_MINIMUM_RSA_BITS)} bits; this key is ${key.asymmetricKeyType ?? 'unknown'} ${String(bits)}`,
    };
  }
  return { ok: true, key };
}

/**
 * The additional authenticated data of one part: its envelope fields, so a part relabelled
 * (another export, another index, another total) fails its tag.
 */
export function trialExportAad(part: { readonly v: 1; readonly alg: string; readonly exportId: string; readonly part: number; readonly of: number }): Buffer {
  return Buffer.from(JSON.stringify({ v: part.v, alg: part.alg, exportId: part.exportId, part: part.part, of: part.of }), 'utf8');
}

export const TRIAL_EXPORT_TAG_BYTES = 16;

/**
 * Encrypt the plaintext to the key, as lines each under the limit. One random content key,
 * wrapped once (on the first part); each part is its own AES-256-GCM message over a slice of
 * the plaintext, with its own 96-bit IV, a 128-bit tag, and its envelope fields as AAD.
 */
export function encryptTrialExport(plaintext: Buffer, key: KeyObject, lineLimitBytes = TRIAL_EXPORT_LINE_LIMIT_BYTES): readonly string[] {
  const contentKey = randomBytes(32);
  const wrappedKey = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, contentKey).toString('base64');
  const exportId = randomBytes(8).toString('hex');
  const header = JSON.stringify({
    v: 1,
    alg: TRIAL_EXPORT_ALG,
    exportId,
    part: 99_999,
    of: 99_999,
    wrappedKey,
    iv: randomBytes(12).toString('base64'),
    tag: randomBytes(TRIAL_EXPORT_TAG_BYTES).toString('base64'),
    ciphertext: '',
  });
  // Plaintext bytes per part: base64 is 4 characters per 3 bytes.
  const sliceBytes = Math.floor(((lineLimitBytes - Buffer.byteLength(header) - 16) * 3) / 4);
  if (sliceBytes < 600) throw new Error('trial export line limit too small for its envelope');
  const slices: Buffer[] = [];
  for (let at = 0; at < plaintext.length || slices.length === 0; at += sliceBytes) slices.push(plaintext.subarray(at, at + sliceBytes));
  const lines = slices.map((slice, index) => {
    const envelope = { v: 1 as const, alg: TRIAL_EXPORT_ALG as typeof TRIAL_EXPORT_ALG, exportId, part: index + 1, of: slices.length };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', contentKey, iv, { authTagLength: TRIAL_EXPORT_TAG_BYTES });
    cipher.setAAD(trialExportAad(envelope));
    const ciphertext = Buffer.concat([cipher.update(slice), cipher.final()]).toString('base64');
    const part: TrialExportPart = {
      ...envelope,
      ...(index === 0 ? { wrappedKey } : {}),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext,
    };
    return JSON.stringify(part);
  });
  contentKey.fill(0);
  return lines;
}

const refuse = (reason: string, detail: string): AdminOutcome => ({ ok: false, reason, detail });

/**
 * Which workspace: `--workspace <slug or id>`, or the only one. Never more than one: the trial
 * is one workspace's (as `send-path report` scopes itself).
 */
export async function trialExportWorkspace(
  session: SessionQueryable,
  named: string | undefined,
): Promise<{ readonly ok: true; readonly workspaceId: string } | { readonly ok: false; readonly reason: string; readonly detail: string }> {
  const { rows } = await session.query<{ id: string; slug: string }>('SELECT id::text AS id, slug FROM workspaces ORDER BY id');
  if (named === undefined) {
    if (rows.length !== 1) return { ok: false, reason: 'workspace_ambiguous', detail: `this database holds ${String(rows.length)} workspaces; name one with --workspace <slug>` };
    return { ok: true, workspaceId: rows[0]?.id ?? '' };
  }
  const found = rows.find(row => row.slug === named || row.id === named);
  return found === undefined ? { ok: false, reason: 'workspace_unknown', detail: 'no workspace on this database has that slug or id' } : { ok: true, workspaceId: found.id };
}

/** One workspace's export plaintext, inside the caller's READ ONLY transaction. */
export async function collectTrialExport(
  session: SessionQueryable,
  options: { readonly workspaceId: string; readonly since: string; readonly maxCalls: number },
): Promise<TrialExportPayload> {
  const context = repositoryContext(workspaceScope(options.workspaceId, { kind: 'system', component: 'worker' }), session);
  return await buildTrialExport(context, { since: options.since, maxCalls: options.maxCalls });
}

export async function trialExportCommand(
  invocation: AdminInvocation,
  emit: (line: string) => void = line => {
    process.stdout.write(`${line}\n`);
  },
): Promise<AdminOutcome> {
  const key = readTrialExportPublicKey(invocation.options['--public-key-pem-b64']);
  if (!key.ok) return refuse(key.reason, key.detail);
  const since = invocation.options['--since'] ?? CALL_TRIAL_DEFAULT_SINCE;
  if (!instant.safeParse(since).success) return refuse('since_invalid', '--since is an ISO instant with an offset, e.g. 2026-10-02T07:14:00Z');
  const maxText = invocation.options['--max-calls'] ?? String(TRIAL_EXPORT_DEFAULT_MAX_CALLS);
  const maxCalls = /^\d+$/u.test(maxText) ? Number(maxText) : Number.NaN;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > TRIAL_EXPORT_MAX_CALLS) {
    return refuse('max_calls_invalid', `--max-calls is a whole number from 1 to ${String(TRIAL_EXPORT_MAX_CALLS)}`);
  }

  const { session } = invocation;
  await session.query('BEGIN TRANSACTION READ ONLY');
  let lines: readonly string[];
  let exported: number;
  try {
    const scope = await trialExportWorkspace(session, invocation.options['--workspace']);
    if (!scope.ok) return refuse(scope.reason, scope.detail);
    const payload = await collectTrialExport(session, { workspaceId: scope.workspaceId, since, maxCalls });
    exported = payload.calls.length;
    const plaintext = Buffer.from(JSON.stringify({ format: 'fss.trial-export.v1', since, workspaces: [payload] }), 'utf8');
    lines = encryptTrialExport(plaintext, key.key);
    plaintext.fill(0);
  } finally {
    await session.query('ROLLBACK');
  }
  for (const line of lines) emit(line);
  return { ok: true, value: { exported } };
}
