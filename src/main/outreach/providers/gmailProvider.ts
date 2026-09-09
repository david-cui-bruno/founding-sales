/* eslint-disable no-control-regex -- MIME inputs must reject NUL before serialization. */
import { z } from 'zod';
import type { EmailSendResult, FrozenEmail, PreparedGmailSender, GmailCredentials } from './providerTypes';
import { requestJsonOnce } from './providerHttp';
import { fail, gmailCredentialsSchema, mailboxSchema, secretSchema } from './providerValidation';

export type FrozenThreadReply = FrozenEmail & { threadId: string; inReplyTo: string; references: string[] };
const rfcId = z.string().max(200).regex(/^[\x21-\x7e]+$/).regex(/^<[^<>\s@]+@[^<>\s@]+>$/);
const emailSchema = z.object({
  commandId: z.string().uuid(), from: mailboxSchema, to: mailboxSchema,
  subject: z.string().min(1).max(240).regex(/^[^\r\n\u0000]*$/),
  body: z.string().min(1).max(24000).regex(/^[^\u0000]*$/),
  threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).optional(),
  inReplyTo: rfcId.optional(), references: z.array(rfcId).min(1).max(50).optional(),
}).strict().refine(value => !value.threadId && !value.inReplyTo && !value.references || Boolean(value.threadId && value.inReplyTo && value.references?.includes(value.inReplyTo)));
type ThreadedEmail = z.infer<typeof emailSchema>;
const receiptSchema = z.object({ id: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/),
  threadId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional() });
const tokenSchema = z.object({ access_token: secretSchema.min(1), token_type: z.literal('Bearer'),
  expires_in: z.number().int().min(60).max(86400), refresh_token: secretSchema.min(1).optional(),
  scope: z.string().max(4000).optional(),
});
export const gmailSendScope = 'https://www.googleapis.com/auth/gmail.send';

export async function refreshGmailToken(input: {
  credentials: GmailCredentials; fetch: typeof globalThis.fetch; signal: AbortSignal; now: () => number;
}): Promise<GmailCredentials> {
  const parsed = gmailCredentialsSchema.safeParse(input.credentials);
  if (!parsed.success || !parsed.data.clientId || !parsed.data.refreshToken || !parsed.data.email) fail('gmail_unconfigured');
  const credentials = parsed.data;
  const body = new URLSearchParams({ client_id: credentials.clientId, refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token' });
  if (credentials.clientSecret) body.set('client_secret', credentials.clientSecret);
  const reply = await requestJsonOnce({ fetch: input.fetch, signal: input.signal,
    url: 'https://oauth2.googleapis.com/token', init: { method: 'POST', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } });
  if ([400, 401, 403].includes(reply.status)) fail('gmail_reauthorize');
  if (reply.status < 200 || reply.status >= 300) fail('provider_rejected');
  const token = tokenSchema.safeParse(reply.data);
  if (!token.success) fail('provider_response_invalid');
  if (token.data.scope !== undefined && !token.data.scope.split(' ').includes(gmailSendScope)) fail('gmail_reauthorize');
  return { ...input.credentials, accessToken: token.data.access_token,
    refreshToken: token.data.refresh_token ?? credentials.refreshToken, expiresAt: input.now() + token.data.expires_in * 1000 };
}

/** A single-use capability, never a queue. Validation and fetch invocation are
 * synchronous. The caller must durably reserve this exact email first.
 */
export function createPreparedGmailSender(input: {
  accountEmail: string; accessToken: string; fetch: typeof globalThis.fetch;
  signal: AbortSignal; isCurrent(): boolean; timeoutMs?: number;
}): PreparedGmailSender {
  if (!mailboxSchema.safeParse(input.accountEmail).success || !secretSchema.min(1).safeParse(input.accessToken).success) fail('gmail_unconfigured');
  const accountEmail = input.accountEmail;
  let flight: { fingerprint: string; promise: Promise<EmailSendResult> } | null = null;
  return Object.freeze({ accountEmail, sendOnce(raw: FrozenEmail): Promise<EmailSendResult> {
    const parsed = emailSchema.safeParse(raw);
    if (!parsed.success || parsed.data.from !== accountEmail) return Promise.resolve({ status: 'not_sent', reasonCode: 'invalid_email' });
    const email = parsed.data;
    let serialized: string;
    try { serialized = mime(email); } catch { return Promise.resolve({ status: 'not_sent', reasonCode: 'invalid_email' }); }
    const fingerprint = JSON.stringify(email);
    if (flight !== null) return flight.fingerprint === fingerprint ? flight.promise
      : Promise.resolve({ status: 'not_sent', reasonCode: 'command_conflict' });
    if (input.signal.aborted || !input.isCurrent()) return Promise.resolve({ status: 'not_sent', reasonCode: 'provider_invalidated' });
    let settle: (value: EmailSendResult) => void;
    const promise = new Promise<EmailSendResult>((resolve) => { settle = resolve; });
    // Install before invoking even an injected/reentrant fetch.
    flight = { fingerprint, promise };
    const pending = requestJsonOnce({ fetch: input.fetch, signal: input.signal, timeoutMs: input.timeoutMs ?? 20000,
      maxBytes: 16384, url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      init: { method: 'POST', headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(serialized).toString('base64url'), ...(email.threadId ? { threadId: email.threadId } : {}) }) },
    });
    pending.then((reply) => {
      if (reply.status >= 400 && reply.status < 500 && reply.status !== 408) {
        settle({ status: 'not_sent', reasonCode: 'provider_rejected' }); return;
      }
      const receipt = receiptSchema.safeParse(reply.data);
      if (reply.status >= 200 && reply.status < 300 && receipt.success) {
        settle({ status: 'accepted', messageId: receipt.data.id, threadId: receipt.data.threadId ?? null });
      } else settle({ status: 'unknown', reasonCode: 'network_uncertain' });
    }, () => settle({ status: 'unknown', reasonCode: 'network_uncertain' }));
    return promise;
  } });
}

function mime(email: ThreadedEmail): string {
  // Encoded words never split UTF-8 codepoints and stay below RFC2047's 75-byte limit.
  const words: string[] = [];
  let text = '';
  for (const character of email.subject) {
    if (Buffer.byteLength(text + character) > 42) { words.push(text); text = ''; }
    text += character;
  }
  if (text) words.push(text);
  const subject = words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
  const body = Buffer.from(email.body.replace(/\r\n|\r|\n/g, '\r\n')).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  const references = ['References:'];
  for (const ref of email.references ?? []) {
    const last = references.length - 1;
    if (Buffer.byteLength(`${references[last]} ${ref}`) > 900) references.push(` ${ref}`);
    else references[last] += ` ${ref}`;
  }
  const headers = [`From: ${email.from}`, `To: ${email.to}`, `Subject: ${subject}`,
    `Message-ID: <${email.commandId}@callie.invalid>`,
    ...(email.inReplyTo ? [`In-Reply-To: ${email.inReplyTo}`, references.join('\r\n')] : []), 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'].join('\r\n');
  if (headers.split('\r\n').some(line => Buffer.byteLength(line) > 998 || !/^[\x20-\x7e]*$/.test(line))) throw new Error('invalid_header');
  return [headers, '', body, ''].join('\r\n');
}
