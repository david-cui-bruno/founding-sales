import type { RepositoryContext } from '../db/workspaceScope.ts';
import { ENVELOPE_ALGORITHM, type EnvelopeCipher, type EnvelopeCiphertext } from './envelope.ts';

/**
 * Reading and writing `mailbox_tokens` (invariant 6, 10.3, Appendix F).
 *
 * Four functions and no fifth. There is no "list tokens", no "export", and nothing
 * that returns a ciphertext to a caller outside this module: `readRefreshToken` is
 * the only way a plaintext exists, it exists for one call, and the only thing that
 * ever receives it is the Gmail client.
 *
 * `deleteRefreshToken` is 10.3's departure rule. It removes the material and leaves
 * every business fact about the mailbox in place, which is why the token is its own
 * table.
 */

interface TokenRow {
  readonly key_id: string;
  readonly algorithm: string;
  readonly wrapped_data_key: Buffer;
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly auth_tag: Buffer;
  readonly [column: string]: unknown;
}

function toEnvelope(row: TokenRow): EnvelopeCiphertext {
  return {
    keyId: row.key_id,
    algorithm: ENVELOPE_ALGORITHM,
    wrappedDataKey: row.wrapped_data_key,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
  };
}

/**
 * Store, or replace, the envelope for one mailbox.
 *
 * An upsert rather than an insert: a re-consent produces a new refresh token for a
 * mailbox that already exists, and the old ciphertext must not survive it. The
 * algorithm column is written from the envelope rather than defaulted, so a future
 * second algorithm cannot be stored under the first one's name.
 */
export async function storeRefreshToken(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly plaintext: string; readonly cipher: EnvelopeCipher },
): Promise<void> {
  const envelope = await input.cipher.encrypt(input.plaintext);
  await context.db.query(
    `INSERT INTO mailbox_tokens (workspace_id, mailbox_id, key_id, algorithm, wrapped_data_key,
                                 ciphertext, iv, auth_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, mailbox_id)
     DO UPDATE SET key_id = EXCLUDED.key_id,
                   algorithm = EXCLUDED.algorithm,
                   wrapped_data_key = EXCLUDED.wrapped_data_key,
                   ciphertext = EXCLUDED.ciphertext,
                   iv = EXCLUDED.iv,
                   auth_tag = EXCLUDED.auth_tag,
                   rotated_at = now()`,
    [
      context.scope.workspaceId,
      input.mailboxId,
      envelope.keyId,
      envelope.algorithm,
      envelope.wrappedDataKey,
      envelope.ciphertext,
      envelope.iv,
      envelope.authTag,
    ],
  );
}

/** The refresh token for one mailbox, or null when there is no grant to use. */
export async function readRefreshToken(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly cipher: EnvelopeCipher },
): Promise<string | null> {
  const { rows } = await context.db.query<TokenRow>(
    `SELECT key_id, algorithm, wrapped_data_key, ciphertext, iv, auth_tag
       FROM mailbox_tokens
      WHERE workspace_id = $1 AND mailbox_id = $2`,
    [context.scope.workspaceId, input.mailboxId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return await input.cipher.decrypt(toEnvelope(row));
}

/** Whether a grant exists at all, without decrypting anything. */
export async function hasRefreshToken(context: RepositoryContext, mailboxId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ present: boolean }>(
    'SELECT true AS present FROM mailbox_tokens WHERE workspace_id = $1 AND mailbox_id = $2',
    [context.scope.workspaceId, mailboxId],
  );
  return rows[0]?.present === true;
}

/** 10.3: departure "deletes refresh-token material". Returns how many rows went. */
export async function deleteRefreshToken(context: RepositoryContext, mailboxId: string): Promise<number> {
  const { rowCount } = await context.db.query(
    'DELETE FROM mailbox_tokens WHERE workspace_id = $1 AND mailbox_id = $2',
    [context.scope.workspaceId, mailboxId],
  );
  return rowCount ?? 0;
}
