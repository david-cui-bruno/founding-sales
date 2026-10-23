import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EmailCampaignAdmission } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { recordSuppression } from '@fss/domain/suppression/events.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { recordMessage } from '@fss/domain/mail/messages.ts';
import { findMatchCandidates, recordMatches } from '@fss/domain/mail/matching.ts';
import { recordDeterministicClassification, applyClassificationEffects } from '@fss/domain/mail/effects.ts';
import { recordingReplyPromoter } from '@fss/domain/mail/replyLane.ts';
import { confirmReplyDisposition } from '@fss/domain/classification/confirmations.ts';
import { consumeTerminalStops } from '@fss/domain/sequences/terminalStops.ts';
import type { ThinHostApp } from './thinHostApp.ts';

function context(app: ThinHostApp) {
  const f = app.fixture;
  return repositoryContext(workspaceScope(f.alpha.workspaceId, { kind: 'user', userId: f.alpha.admin.userId, role: 'admin' }), f.db);
}
export async function suppressCampaignAddress(app: ThinHostApp, email: string) {
  const ctx = context(app);
  const result = await withTransaction(ctx.db, () => recordSuppression(ctx, {
    scope: 'handle', value: email, source: 'prospect_opt_out', channel: 'email', commandId: randomUUID(), journal: recordingSuppressionJournal(),
  }));
  assert(result.ok, result.ok ? '' : result.reason);
  return result.value;
}

/** Uses normal message matching, deterministic uncertain classification, human
 * confirmation and terminal-stop consumption. No classifier/provider invocation. */
export async function confirmCampaignReply(app: ThinHostApp, mailboxId: string, email: string, admission: EmailCampaignAdmission, disposition: 'not_interested' | 'opt_out') {
  const ctx = context(app);
  const tx = <T>(work: () => Promise<T>) => withTransaction(ctx.db, work);
  const metadata = { providerMessageId: randomUUID(), providerThreadId: randomUUID(), rfcMessageId: `${randomUUID()}@example.test`, direction: 'incoming' as const,
    internalDate: new Date().toISOString(), headerFrom: email, headerTo: ['owner@example.test'], headerCc: [], subject: 'Re: Controlled local example',
    referenceMessageIds: [], inReplyTo: null, autoSubmitted: null, listId: null, labelIds: [], attachments: [] };
  const recorded = await tx(() => recordMessage(ctx, { mailboxId, metadata }));
  const candidates = await findMatchCandidates(ctx, { mailboxId, messageId: recorded.message.id, metadata });
  assert(candidates.some(row => row.firmId === admission.firmId && row.outreachPlanId === admission.planId), 'Real matching must resolve the exact campaign plan');
  await tx(() => recordMatches(ctx, { messageId: recorded.message.id, candidates }));
  const classification = { messageId: recorded.message.id, class: 'uncertain' as const, suggestedDisposition: null, signals: [], requiresConfirmation: true };
  await tx(async () => {
    await recordDeterministicClassification(ctx, { messageId: recorded.message.id, classification });
    await applyClassificationEffects(ctx, { message: recorded.message, classification, candidates, journal: recordingSuppressionJournal(), replyPromoter: recordingReplyPromoter() });
  });
  const confirmed = await tx(() => confirmReplyDisposition(ctx, { messageId: recorded.message.id, disposition, firmWideOptOut: disposition === 'opt_out', journal: recordingSuppressionJournal() }));
  assert(confirmed.ok, confirmed.ok ? '' : confirmed.reason);
  await tx(() => consumeTerminalStops(ctx));
  return recorded.message.id;
}
