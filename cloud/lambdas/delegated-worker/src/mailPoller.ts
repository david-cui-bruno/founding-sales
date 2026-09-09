import { randomUUID } from 'node:crypto';
import { createGmailThreadProvider } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import type { RemoteGoogleAuthorization } from './remoteGoogleAuthorization';
import type { DynamoThreadIntakeRepository } from './threadIntakeRepository';
export const MAIL_POLL_INTERVAL_MS = 120000;
export type MailPollTarget = { pairingId: string; accountId: string; mailboxSubject: string };
/** Scheduler composition supplies only explicitly authorized account contacts.
 * This never dispatches. C5 must hold dispatch on incomplete or failed intake and
 * check durable suppression/context again at its final action fence. */
export function createMailPoller(input: { authorization: Pick<RemoteGoogleAuthorization, 'authorizedAccess'>;
  store: DynamoThreadIntakeRepository; fetch: typeof globalThis.fetch }) {
  return { async pollOnce(target: MailPollTarget, signal: AbortSignal) {
    const attemptId = randomUUID();
    await input.store.beginPoll(target.accountId, target.mailboxSubject, attemptId);
    try {
      const access = await input.authorization.authorizedAccess(target.pairingId, ['relevant_read'], signal);
      if (access.grant.owner !== 'remote' || access.grant.subject !== target.mailboxSubject) throw new Error('remote_grant_required');
      const state = await input.store.cursorState(target.accountId, access.grant.subject);
      const scope = state?.data.scope;
      if (!scope || state.data.poll?.attemptId !== attemptId || state.data.poll.status !== 'pending') throw new Error('stale_poll_attempt');
      const cursor = state.data.checkpoint;
      const provider = createGmailThreadProvider({ ...access, fetch: input.fetch });
      const page = await provider.readRelevantThreads({ accountId: target.accountId, scope, knownThreadIds: scope.knownThreadIds,
        participantAddresses: scope.participantAddresses, since: scope.since, cursor, maxPages: 1, maxBodyBytes: 12000 }, signal);
      if (signal.aborted) throw new Error('mail_poll_cancelled');
      const results = await input.store.applyPage(page, cursor, attemptId);
      return { complete: page.complete, suppressed: await input.store.isSuppressed(target.accountId), results };
    } catch (error) {
      // An ambiguous persistence error can leave pending, which is fail-closed.
      await input.store.failPoll(target.accountId, target.mailboxSubject, attemptId).catch(() => undefined);
      throw error;
    }
  } };
}
