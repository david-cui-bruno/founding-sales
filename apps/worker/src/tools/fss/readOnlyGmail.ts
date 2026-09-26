import type { GmailClient } from '@fss/domain/mail/gmailClient.ts';

/**
 * The Gmail client `fss admin mailbox reconcile-sent` is handed (lane W3-S8).
 *
 * The restore runbook (`docs/greenfield/runbooks/restore.md`) runs that command against
 * production's real mailboxes, with `FSS_DEPENDENCIES=live`, while both services are
 * stopped. What it needs from Gmail is a token refresh, the Sent-folder listing, the
 * `rfc822msgid:` search and message metadata. Everything else a `GmailClient` can do is
 * refused here — a send, a watch or its stop, a code exchange, a revocation, a body read
 * — so the command cannot write to a mailbox whatever the code below it calls, and a
 * refusal is an error that stops the command rather than a silent no-op.
 */

export class GmailCallRefused extends Error {
  constructor(readonly method: string) {
    super(`the read-only Gmail client refuses ${method}: fss admin reads Sent folders and nothing else`);
    this.name = 'GmailCallRefused';
  }
}

const refusedAsync =
  (method: string) =>
  (): Promise<never> =>
    Promise.reject(new GmailCallRefused(method));

export function readOnlyGmail(gmail: GmailClient): GmailClient {
  return {
    authorizationUrl: (): never => {
      throw new GmailCallRefused('authorizationUrl');
    },
    exchangeAuthorizationCode: refusedAsync('exchangeAuthorizationCode'),
    revokeRefreshToken: refusedAsync('revokeRefreshToken'),
    watch: refusedAsync('watch'),
    stopWatch: refusedAsync('stopWatch'),
    getBody: refusedAsync('getBody'),
    sendMessage: refusedAsync('sendMessage'),
    refreshAccessToken: async (config, refreshToken) => await gmail.refreshAccessToken(config, refreshToken),
    getProfile: async access => await gmail.getProfile(access),
    listHistory: async (access, request) => await gmail.listHistory(access, request),
    listMessageIds: async (access, request) => await gmail.listMessageIds(access, request),
    getMetadata: async (access, messageId, headers) => await gmail.getMetadata(access, messageId, headers),
    getSentMetadata: async (access, messageId, headers) => await gmail.getSentMetadata(access, messageId, headers),
    searchSentByMessageId: async (access, rfcMessageId) => await gmail.searchSentByMessageId(access, rfcMessageId),
    listSentMessageIds: async (access, request) => await gmail.listSentMessageIds(access, request),
  };
}
