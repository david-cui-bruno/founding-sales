import type { FrozenEmail } from '../../../../src/main/outreach/providers/providerTypes';
import { mailMessageSchema, type MailMessage } from '../../../../src/shared/contracts/mailThreadContract';

export type ProviderIdentity = { messageId: string; threadId: string | null };
export type ReconciliationOutcome = { status: 'unknown'; reason: 'sent_absent' | 'sent_ambiguous' | 'sent_mismatch' | 'lookup_unavailable' | 'reservation_missing' | 'evidence_uncommitted' }
  | { status: 'provider_accepted'; reason: 'sent_match'; providerIdentity: ProviderIdentity };
export type ThreadedFrozenEmail = FrozenEmail & { threadId?: string; inReplyTo?: string; references?: string[] };
const lines = (value: string) => value.replace(/\r\n|\r/g, '\n');
/** Absence is not evidence of non-delivery. Never yields a resend capability. */
export function verifySentMatch(email: ThreadedFrozenEmail, messages: MailMessage[]): ReconciliationOutcome {
  if (messages.length === 0) return { status: 'unknown', reason: 'sent_absent' };
  if (messages.length !== 1) return { status: 'unknown', reason: 'sent_ambiguous' };
  const parsed = mailMessageSchema.safeParse(messages[0]);
  if (!parsed.success) return { status: 'unknown', reason: 'sent_mismatch' };
  const message = parsed.data;
  const parts = message.bodyParts;
  if (message.rfcMessageId !== `<${email.commandId}@callie.invalid>` || message.from.length !== 1 || message.from[0] !== email.from
    || message.to.length !== 1 || message.to[0] !== email.to || message.cc.length !== 0 || message.subject !== email.subject
    || email.references !== undefined && JSON.stringify(message.references) !== JSON.stringify(email.references)
    || email.threadId !== undefined && message.threadId !== email.threadId
    || parts.length !== 1 || parts[0]!.mimeType !== 'text/plain' || parts[0]!.truncated || lines(parts[0]!.text) !== lines(email.body)) {
    return { status: 'unknown', reason: 'sent_mismatch' };
  }
  return { status: 'provider_accepted', reason: 'sent_match', providerIdentity: { messageId: message.id, threadId: message.threadId } };
}

import { z } from 'zod';
import { requestJsonOnce } from '../../../../src/main/outreach/providers/providerHttp';
import type { DispatchDependencies } from './dispatchService';
import { type SendEvidence } from './dispatchRepository';
import { fingerprint } from './dynamoStore';
const providerId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const sentListSchema = z.object({ messages: z.array(z.object({ id: providerId })).max(2).optional(), nextPageToken: z.string().optional() });
const sentRawSchema = z.object({ id: providerId, threadId: providerId, labelIds: z.array(z.string()).max(100), internalDate: z.string().regex(/^\d+$/),
  payload: z.object({ mimeType: z.literal('text/plain'), filename: z.literal('').optional(), parts: z.array(z.never()).max(0).optional(), headers: z.array(z.object({ name: z.string().max(100), value: z.string().max(4000) })).max(100),
    body: z.object({ data: z.string().max(100000), size: z.number().int().nonnegative(), attachmentId: z.never().optional() }) }) });
function decodedSubject(value: string): string {
  if (!value.includes('=?')) return value;
  const words = value.trim().split(/\s+/);
  return words.map(word => {
    const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/]+={0,2})\?=$/i.exec(word);
    if (!match) throw new Error('unsupported_subject_encoding');
    const bytes = Buffer.from(match[1]!, 'base64');
    if (bytes.toString('base64') !== match[1]) throw new Error('invalid_subject_encoding');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }).join('');
}
/** Narrow bounded Sent lookup. No send port or retry path exists here. */
export function createSendReconciler(input: DispatchDependencies) {
  return { async reconcileSend(commandId: string): Promise<ReconciliationOutcome> {
    try {
      const intent = await input.policy.loadIntent(commandId);
      if (!intent) return { status: 'unknown', reason: 'reservation_missing' };
      const action = await input.execution.readDispatch(intent.action.accountId, intent.action.actionId);
      if (!action?.reservation || !['dispatching', 'unknown', 'provider_accepted'].includes(action.state)) return { status: 'unknown', reason: 'reservation_missing' };
      const reservation = action.reservation;
      if (reservation.contentHash !== fingerprint(intent.frozenMessage) || reservation.targetHash !== intent.action.targetHash) return { status: 'unknown', reason: 'sent_mismatch' };
      const existing = await input.policy.sendEvidence(commandId);
      const accepted = existing.find(evidence => evidence.state === 'provider_accepted' && fingerprint(evidence.reservation) === fingerprint(reservation));
      if (accepted?.providerIdentity) return { status: 'provider_accepted', reason: 'sent_match', providerIdentity: accepted.providerIdentity };
      const signal = new AbortController().signal;
      const access = await input.authorization.authorizedAccess(intent.pairingId, ['relevant_read'], signal);
      if (access.grant.subject !== intent.mailboxSubject || access.grant.email !== intent.frozenMessage.from || access.grant.owner !== 'remote') return { status: 'unknown', reason: 'lookup_unavailable' };
      const get = async (path: string, params: Record<string, string>) => {
        const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`); url.search = new URLSearchParams(params).toString();
        const response = await requestJsonOnce({ fetch: input.fetch, signal, url: url.href, maxBytes: 200000,
          init: { method: 'GET', headers: { Authorization: `Bearer ${access.accessToken}` } } });
        if (response.status !== 200) throw new Error('lookup_unavailable');
        return response.data;
      };
      const listing = sentListSchema.parse(await get('messages', { q: `in:sent rfc822msgid:${commandId}@callie.invalid`, maxResults: '2' }));
      if (listing.nextPageToken || (listing.messages?.length ?? 0) > 1) return { status: 'unknown', reason: 'sent_ambiguous' };
      if (!listing.messages?.length) return { status: 'unknown', reason: 'sent_absent' };
      const raw = sentRawSchema.parse(await get(`messages/${listing.messages[0]!.id}`, { format: 'full' }));
      if (raw.id !== listing.messages[0]!.id || !raw.labelIds.includes('SENT')) return { status: 'unknown', reason: 'sent_mismatch' };
      const header = (name: string) => {
        const values = raw.payload.headers.filter(header => header.name.toLowerCase() === name);
        if (values.length > 1) throw new Error('duplicate_header');
        return values[0]?.value ?? '';
      };
      // This is evidence for our exact single-part sender, not a general MIME parser.
      // Never drop recipient-routing headers or reinterpret attachments/charsets.
      const names = raw.payload.headers.map(item => item.name.toLowerCase());
      const extraRouting = new Set(['bcc', 'sender', 'reply-to', 'apparently-to', 'errors-to', 'mail-followup-to', 'mail-reply-to']);
      if (names.some(name => extraRouting.has(name) || name.startsWith('resent-'))
        || header('mime-version').trim() !== '1.0'
        || !/^text\/plain\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(header('content-type'))
        || header('content-transfer-encoding').trim().toLowerCase() !== 'base64'
        || names.includes('content-disposition') && header('content-disposition').trim().toLowerCase() !== 'inline'
        || names.some(name => name.startsWith('content-') && !['content-type', 'content-transfer-encoding', 'content-disposition'].includes(name))) {
        return { status: 'unknown', reason: 'sent_mismatch' };
      }
      const bytes = Buffer.from(raw.payload.body.data, 'base64url');
      if (bytes.toString('base64url') !== raw.payload.body.data.replace(/=+$/, '') || bytes.length !== raw.payload.body.size) return { status: 'unknown', reason: 'sent_mismatch' };
      const outcome = verifySentMatch(intent.frozenMessage, [mailMessageSchema.parse({ id: raw.id, threadId: raw.threadId,
        rfcMessageId: header('message-id'), references: header('references').match(/<[^<>\s]+>/g) ?? [], from: [header('from')], to: [header('to')],
        cc: header('cc') ? header('cc').split(',').map(value => value.trim()) : [], date: new Date(Number(raw.internalDate)).toISOString(), subject: decodedSubject(header('subject')),
        bodyParts: [{ mimeType: 'text/plain', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), truncated: false }] })]);
      if (outcome.status !== 'provider_accepted') return outcome;
      if (header('in-reply-to') !== intent.frozenMessage.inReplyTo) return { status: 'unknown', reason: 'sent_mismatch' };
      const observedAt = input.policy.store.now();
      const evidence: SendEvidence = { commandId, reservation, state: 'provider_accepted', observedAt, kind: 'sent_lookup', reason: 'sent_match',
        rfcMessageId: `<${commandId}@callie.invalid>`, providerIdentity: outcome.providerIdentity };
      try { await input.execution.appendOutcome({ reservation, state: 'provider_accepted', observedAt, evidenceRef: `sent-${fingerprint(evidence)}` }, evidence); }
      catch { return { status: 'unknown', reason: 'evidence_uncommitted' }; }
      return outcome;
    } catch { return { status: 'unknown', reason: 'lookup_unavailable' }; }
  } };
}
