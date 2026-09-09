import { z } from 'zod';
import { mailCheckpointSchema, mailMessageSchema, type MailMessage, type ThreadPage, type ThreadReadRequest, type MailCheckpoint } from '../../../shared/contracts/mailThreadContract';
import { requireCapabilities, type GoogleGrant } from '../../../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
import { requestJsonOnce } from './providerHttp';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const listSchema = z.object({ messages: z.array(z.object({ id })).max(100).optional(), nextPageToken: z.string().max(2048).optional(), historyId: z.string().regex(/^\d+$/).optional(),
  history: z.array(z.object({ messagesAdded: z.array(z.object({ message: z.object({ id }) })).max(100).optional() })).max(100).optional() });
type Part = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string }; parts?: Part[] };
const rawSchema = z.object({ id, threadId: id, internalDate: z.string().regex(/^\d+$/), payload: z.object({ headers: z.array(z.object({ name: z.string().max(100), value: z.string().max(4000) })).max(100) }).passthrough() });
function addresses(value: string): string[] {
  if (!value) return [];
  return value.split(',').map(part => {
    const clean = part.trim(); const angle = /^[^<>]*<([^<>]+)>$/.exec(clean);
    return z.string().email().parse(angle?.[1] ?? clean).toLowerCase();
  });
}
function metadata(raw: unknown): MailMessage {
  const value = rawSchema.parse(raw);
  const header = (name: string) => {
    const values = value.payload.headers.filter(h => h.name.toLowerCase() === name);
    if (values.length > 1) throw new Error('duplicate_mail_header');
    return values[0]?.value ?? '';
  };
  return mailMessageSchema.parse({ id: value.id, threadId: value.threadId, rfcMessageId: header('message-id') || null,
    references: (header('references') + ' ' + header('in-reply-to')).match(/<[^<>\s]+>/g) ?? [],
    from: addresses(header('from')), to: addresses(header('to')), cc: addresses(header('cc')),
    date: new Date(Number(value.internalDate)).toISOString(), subject: header('subject'), bodyParts: [] });
}
function selectedParts(part: Part, budget: number): MailMessage['bodyParts'] {
  const parts: MailMessage['bodyParts'] = []; let nodes = 0; let remaining = budget;
  const walk = (node: Part, depth: number) => {
    if (++nodes > 100 || depth > 10) throw new Error('mime_capacity_exceeded');
    if (node.filename) return;
    if ((node.mimeType === 'text/plain' || node.mimeType === 'text/html') && node.body?.data && parts.length < 4) {
      if (!/^[A-Za-z0-9_-]*={0,2}$/.test(node.body.data)) throw new Error('invalid_mail_encoding');
      const bytes = Buffer.from(node.body.data, 'base64url');
      if (bytes.toString('base64url') !== node.body.data.replace(/=+$/, '')) throw new Error('invalid_mail_encoding');
      let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // HTML is converted to inert evidence, never rendered or remotely loaded.
      if (node.mimeType === 'text/html') text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
      const bounded: string[] = []; let used = 0;
      for (const char of text) { const size = Buffer.byteLength(char); if (used + size > remaining) break; bounded.push(char); used += size; }
      const selected = bounded.join(''); remaining -= used;
      parts.push({ mimeType: node.mimeType, text: selected, truncated: selected.length < text.length });
    }
    for (const child of node.parts ?? []) walk(child, depth + 1);
  };
  walk(part, 0); return parts;
}
export function createGmailThreadProvider(input: { grant: GoogleGrant; accessToken: string; fetch: typeof globalThis.fetch; now?: () => number }) {
  requireCapabilities(input.grant, ['relevant_read']);
  if (!input.accessToken || /[\r\n]/.test(input.accessToken)) throw new Error('invalid_access_token');
  return { async readRelevantThreads(request: ThreadReadRequest, signal: AbortSignal): Promise<ThreadPage> {
    z.string().min(1).max(255).parse(request.accountId);
    z.number().int().min(1).max(5).parse(request.maxPages); z.number().int().min(1).max(24000).parse(request.maxBodyBytes);
    z.array(id).max(100).parse(request.knownThreadIds);
    const contacts = z.array(z.string().email().regex(/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+$/)).min(1).max(20).parse(request.participantAddresses).map(s => s.toLowerCase());
    z.string().datetime().parse(request.since);
    const boundedSince = new Date(Math.max(Date.parse(request.since), (input.now ?? Date.now)() - 30 * 86400000)).toISOString();
    let checkpoint = request.cursor ? mailCheckpointSchema.parse(request.cursor) : null;
    if (checkpoint && (checkpoint.accountId !== request.accountId || checkpoint.mailboxSubject !== input.grant.subject || checkpoint.since !== request.since)) throw new Error('mail_checkpoint_identity_conflict');
    const get = async (path: string, params: Record<string, string> = {}) => {
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`); url.search = new URLSearchParams(params).toString();
      return requestJsonOnce({ fetch: input.fetch, signal, url: url.href, maxBytes: 512000,
        init: { method: 'GET', headers: { Authorization: `Bearer ${input.accessToken}` } } });
    };
    const scan = async (): Promise<MailCheckpoint> => {
      const response = await get('profile'); if (response.status !== 200) throw new Error('gmail_read_rejected');
      const profile = z.object({ historyId: z.string().regex(/^\d+$/) }).parse(response.data);
      return { version: 1, accountId: request.accountId, mailboxSubject: input.grant.subject, mode: 'scan', historyId: profile.historyId, pageToken: null, since: request.since };
    };
    checkpoint ??= await scan();
    const threads: ThreadPage['threads'] = []; let complete = false;
    const relevant = (m: MailMessage) => m.from.length === 1 && m.from.every(a => contacts.includes(a))
      && [...m.to, ...m.cc].includes(input.grant.email.toLowerCase())
      && [...m.to, ...m.cc].every(a => a === input.grant.email.toLowerCase() || contacts.includes(a)) && m.date >= boundedSince;
    for (let page = 0; page < request.maxPages; page++) {
      const params: Record<string, string> = { maxResults: '20' };
      if (checkpoint.pageToken) params.pageToken = checkpoint.pageToken;
      if (checkpoint.mode === 'history') { params.startHistoryId = checkpoint.historyId; params.historyTypes = 'messageAdded'; }
      else params.q = `after:${Math.floor(Date.parse(boundedSince) / 1000)} {${contacts.map(a => `from:${a}`).join(' ')}}`;
      const response = await get(checkpoint.mode === 'history' ? 'history' : 'messages', params);
      if (response.status === 404 && checkpoint.mode === 'history') { checkpoint = await scan(); page--; continue; }
      if (response.status !== 200) throw new Error('gmail_read_rejected');
      const listing = listSchema.parse(response.data);
      const ids = [...new Set(checkpoint.mode === 'history' ? (listing.history ?? []).flatMap(h => (h.messagesAdded ?? []).map(m => m.message.id)) : (listing.messages ?? []).map(m => m.id))];
      if (ids.length > 100) throw new Error('mail_page_capacity_exceeded');
      for (const messageId of ids) {
        const meta = await get(`messages/${messageId}`, { format: 'metadata' });
        if (meta.status === 404) continue;
        if (meta.status !== 200) throw new Error('gmail_read_rejected');
        const candidate = metadata(meta.data);
        if (candidate.id !== messageId || !relevant(candidate)) continue;
        const full = await get(`messages/${messageId}`, { format: 'full' });
        if (full.status === 404) continue;
        if (full.status !== 200) throw new Error('gmail_read_rejected');
        const message = metadata(full.data);
        if (JSON.stringify(message) !== JSON.stringify(candidate)) throw new Error('mail_metadata_changed');
        message.bodyParts = selectedParts(rawSchema.parse(full.data).payload as Part, request.maxBodyBytes);
        let thread = threads.find(t => t.providerThreadId === message.threadId);
        if (!thread) { thread = { accountId: request.accountId, mailboxSubject: input.grant.subject, provider: 'gmail', providerThreadId: message.threadId, messages: [] }; threads.push(thread); }
        if (!thread.messages.some(m => m.id === message.id)) thread.messages.push(message);
      }
      const token = listing.nextPageToken ?? null;
      const ended = token === null;
      const wasHistory: boolean = checkpoint.mode === 'history';
      if (ended && wasHistory && !listing.historyId) throw new Error('gmail_history_checkpoint_missing');
      complete = ended && wasHistory;
      checkpoint = { ...checkpoint, pageToken: token, ...(ended ? { mode: 'history', historyId: wasHistory ? listing.historyId! : checkpoint.historyId } : {}) };
      if (complete) break;
    }
    return { threads, nextCursor: mailCheckpointSchema.parse(checkpoint), complete };
  } };
}
