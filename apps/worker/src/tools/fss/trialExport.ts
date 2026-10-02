import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes, type KeyObject } from 'node:crypto';
import { CALL_TRIAL_DEFAULT_SINCE, instant } from '@fss/contracts';
import { buildTrialExport, type TrialExportPayload } from '@fss/domain/calls/trialExport.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { listWorkspaceIds } from '@fss/domain/restore';
import type { AdminInvocation, AdminOutcome } from './admin.ts';

/**
 * `fss admin trial export` (slice S3T-E; David's approval of 2 October 2026): the ten-call
 * trial, encrypted to David's public key, for a review he runs on his own Mac through AWS
 * Bedrock (`tools/trial-review/`). Read only: one READ ONLY transaction, rolled back.
 *
 * What is selected is what `GET /calls/trial` counts toward ten (`computeCallTrial`), oldest
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
 *   * `{v:1, alg, exportId, part, of, wrappedKey, iv, tag, ciphertext}` — the first part
 *     carries the key, the IV and the tag; every part a slice of the base64 ciphertext;
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
  readonly wrappedKey?: string;
  readonly iv?: string;
  readonly tag?: string;
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

/** Encrypt the plaintext to the key, as lines each under the limit. */
export function encryptTrialExport(plaintext: Buffer, key: KeyObject, lineLimitBytes = TRIAL_EXPORT_LINE_LIMIT_BYTES): readonly string[] {
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
  const tag = cipher.getAuthTag().toString('base64');
  const wrappedKey = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, contentKey).toString('base64');
  contentKey.fill(0);
  const exportId = randomBytes(8).toString('hex');
  // Room for the envelope around each slice: the key and the IV ride on the first part.
  const header = JSON.stringify({ v: 1, alg: TRIAL_EXPORT_ALG, exportId, part: 999, of: 999, wrappedKey, iv: iv.toString('base64'), tag, ciphertext: '' });
  const slice = lineLimitBytes - Buffer.byteLength(header) - 16;
  if (slice < 1_000) throw new Error('trial export line limit too small for its envelope');
  const pieces: string[] = [];
  for (let at = 0; at < ciphertext.length || pieces.length === 0; at += slice) pieces.push(ciphertext.slice(at, at + slice));
  return pieces.map((piece, index) => {
    const part: TrialExportPart = {
      v: 1,
      alg: TRIAL_EXPORT_ALG,
      exportId,
      part: index + 1,
      of: pieces.length,
      ...(index === 0 ? { wrappedKey, iv: iv.toString('base64'), tag } : {}),
      ciphertext: piece,
    };
    return JSON.stringify(part);
  });
}

const refuse = (reason: string, detail: string): AdminOutcome => ({ ok: false, reason, detail });

/** The plaintext of every workspace's export, inside the caller's READ ONLY transaction. */
export async function collectTrialExport(
  session: SessionQueryable,
  options: { readonly since: string; readonly maxCalls: number },
): Promise<{ readonly workspaces: readonly TrialExportPayload[]; readonly calls: number }> {
  const workspaces: TrialExportPayload[] = [];
  let remaining = options.maxCalls;
  for (const workspaceId of await listWorkspaceIds(session)) {
    if (remaining <= 0) break;
    const context = repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), session);
    const payload = await buildTrialExport(context, { since: options.since, maxCalls: remaining });
    if (payload.calls.length === 0) continue;
    workspaces.push(payload);
    remaining -= payload.calls.length;
  }
  return { workspaces, calls: options.maxCalls - remaining };
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
    const collected = await collectTrialExport(session, { since, maxCalls });
    exported = collected.calls;
    const plaintext = Buffer.from(JSON.stringify({ format: 'fss.trial-export.v1', since, workspaces: collected.workspaces }), 'utf8');
    lines = encryptTrialExport(plaintext, key.key);
    plaintext.fill(0);
  } finally {
    await session.query('ROLLBACK');
  }
  for (const line of lines) emit(line);
  return { ok: true, value: { exported } };
}
