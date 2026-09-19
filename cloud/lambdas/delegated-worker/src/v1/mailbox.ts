import { z } from 'zod';
import type { DynamoStore } from '../dynamoStore';
import type { RemoteGoogleAuthorization } from '../remoteGoogleAuthorization';
import { grantAccess, readGrant } from './grant';

/**
 * The one seam through which the rebuilt core reaches the mailbox (slice S3). The send fence, the reconcile job
 * and the poller all ask this for the connected address and a usable access token, and every one of them holds
 * with `mailbox_not_connected` when the answer is no. A missing or refused grant is never inferred to be fine,
 * and nothing here ever returns a token it did not just obtain.
 *
 * Until the cutover (S6) the grant is still the worker-held, pairing-bound `GOOGLE_GRANT#<pairingId>` record the
 * existing flow writes; the design replaces it with `GRANT#google` after a fresh consent. This adapter therefore
 * finds that single record rather than being handed a pairing id: exactly one usable grant is a connected
 * mailbox, and zero or more than one is `mailbox_not_connected`, which is the honest answer in both cases.
 */

export type MailboxConnection =
  | { connected: true; email: string; subject: string; accessToken: string }
  | { connected: false; reason: 'mailbox_not_connected' };

export interface MailboxAccess {
  /** The connected mailbox and a token good for `send` and `relevant_read`, or the closed refusal. Never throws. */
  access(signal: AbortSignal): Promise<MailboxConnection>;
}

export const GOOGLE_GRANT_PREFIX = 'GOOGLE_GRANT#';
/** The legacy-purpose grant keys only: the personal-availability grant carries its own suffix and is not the mailbox. */
export function grantPairingIds(keys: readonly string[]): string[] {
  return [...new Set(keys.flatMap(key => {
    if (!key.startsWith(GOOGLE_GRANT_PREFIX) || key.includes('#personal_availability')) return [];
    const encoded = key.slice(GOOGLE_GRANT_PREFIX.length);
    try { return [decodeURIComponent(encoded)]; } catch { return []; }
  }))].sort();
}

const grantRowSchema = z.object({ revoked: z.boolean().optional(), grant: z.object({ email: z.string(), subject: z.string() }).optional() });

export function createWorkerGrantMailboxAccess(input: { store: DynamoStore; authorization: RemoteGoogleAuthorization }): MailboxAccess {
  return { async access(signal: AbortSignal): Promise<MailboxConnection> {
    try {
      // S6: the fresh consent's `GRANT#google` is the mailbox once it exists. The pairing-bound record below is
      // the carry, read only until the cutover writes the new one; after the cutover it is revoked and then, at
      // S7, deleted. One record answers at a time, and a workspace with neither is `mailbox_not_connected`.
      if (await readGrant(input.store)) {
        return await grantAccess(input.store, input.authorization.input.config, input.authorization.input.fetch ?? globalThis.fetch);
      }
      const rows = await input.store.list<unknown>(GOOGLE_GRANT_PREFIX);
      const live = rows.filter(row => {
        if (row.key.includes('#personal_availability')) return false;
        const parsed = grantRowSchema.safeParse(row.stored.data);
        return parsed.success && parsed.data.revoked !== true && parsed.data.grant !== undefined;
      });
      const pairingIds = grantPairingIds(live.map(row => row.key));
      if (pairingIds.length !== 1) return { connected: false, reason: 'mailbox_not_connected' };
      const access = await input.authorization.authorizedAccess(pairingIds[0]!, ['send', 'relevant_read'], signal);
      if (access.grant.owner !== 'remote') return { connected: false, reason: 'mailbox_not_connected' };
      return { connected: true, email: access.grant.email, subject: access.grant.subject, accessToken: access.accessToken };
    } catch {
      // A refused refresh after a revoked grant is exactly this condition, which is why it is not an error here.
      return { connected: false, reason: 'mailbox_not_connected' };
    }
  } };
}
