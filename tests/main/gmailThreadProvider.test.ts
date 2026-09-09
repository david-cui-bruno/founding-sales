import { describe, expect, it } from 'vitest';
import { createGmailThreadProvider } from '../../src/main/outreach/providers/gmailThreadProvider';
import { createPreparedGmailSender } from '../../src/main/outreach/providers/gmailProvider';
import { googleScopes, type GoogleGrant } from '../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
const grant: GoogleGrant = { provider: 'google', subject: 'subject-1', email: 'founder@fixture.invalid', owner: 'remote', purpose: 'permitted_correspondence', capabilities: ['relevant_read'], grantedScopes: [googleScopes.relevant_read] };
const request: import('../../src/shared/contracts/mailThreadContract').ThreadReadRequest = { accountId: 'account-1', knownThreadIds: ['t1'], participantAddresses: ['pm@fixture.invalid'], since: '2026-09-01T00:00:00.000Z', cursor: null, maxPages: 1, maxBodyBytes: 100 };
const metadata = (id: string, from = 'pm@fixture.invalid') => ({ id, threadId: 't1', internalDate: String(Date.parse('2026-09-08T12:00:00.000Z')), payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: grant.email }, { name: 'Subject', value: 'Same subject' }, { name: 'Message-ID', value: `<${id}@fixture.invalid>` }], mimeType: 'text/plain', body: { data: Buffer.from('A relevant reply').toString('base64url') } } });
function transport(handler: (url: URL, init?: RequestInit) => unknown) { return (async (url, init) => new Response(JSON.stringify(handler(new URL(String(url)), init)), { status: 200 })) as typeof fetch; }
describe('actual Gmail HTTP thread adapter', () => {
  it('filters metadata before fetching bodies, checkpoints pagination and does not require INBOX', async () => {
    const urls: string[] = [];
    const fetch = transport(url => { urls.push(url.href);
      if (url.pathname.endsWith('/profile')) return { historyId: '10' };
      if (url.pathname.endsWith('/messages')) return { messages: [{ id: 'm1' }, { id: 'unrelated' }], nextPageToken: 'page2' };
      if (url.pathname.endsWith('/unrelated')) return metadata('unrelated', 'stranger@fixture.invalid');
      return metadata('m1');
    });
    const page = await createGmailThreadProvider({ now: () => Date.parse('2026-09-08T12:00:00.000Z'), grant, accessToken: 'fixture-token', fetch }).readRelevantThreads(request, new AbortController().signal);
    expect(page.threads[0]?.messages[0]?.bodyParts[0]?.text).toBe('A relevant reply');
    expect(page.complete).toBe(false);
    expect(page.nextCursor).toMatchObject({ mode: 'scan', historyId: '10', pageToken: 'page2' });
    expect(urls.filter(url => url.includes('unrelated') && url.includes('format=full'))).toHaveLength(0);
    expect(urls.join(' ')).not.toMatch(/INBOX|labelIds/);
    expect(new URL(urls.find(url => url.includes('/messages?'))!).searchParams.get('q')).toContain('after:');
  });
  it('uses history pagination and never advances startHistoryId on an incomplete page', async () => {
    const urls: URL[] = [];
    const fetch = transport(url => { urls.push(url); return url.pathname.endsWith('/history') ? { historyId: '99', nextPageToken: 'p2', history: [{ messagesAdded: [{ message: { id: 'm1' } }] }] } : metadata('m1'); });
    const page = await createGmailThreadProvider({ now: () => Date.parse('2026-09-08T12:00:00.000Z'), grant, accessToken: 'fixture-token', fetch }).readRelevantThreads({ ...request, cursor: { version: 1, accountId: request.accountId, mailboxSubject: grant.subject, mode: 'history', historyId: '10', pageToken: null, since: request.since } }, new AbortController().signal);
    expect(page.nextCursor.historyId).toBe('10');
    expect(urls[0]?.searchParams.get('startHistoryId')).toBe('10');
  });
  it('fails closed on missing capability and cursor subject mismatch before HTTP', async () => {
    let calls = 0;
    const fetch = transport(() => { calls++; return {}; });
    expect(() => createGmailThreadProvider({ now: () => Date.parse('2026-09-08T12:00:00.000Z'), grant: { ...grant, capabilities: [] }, accessToken: 'x', fetch })).toThrow('grant_missing_capability');
    const provider = createGmailThreadProvider({ now: () => Date.parse('2026-09-08T12:00:00.000Z'), grant, accessToken: 'x', fetch });
    await expect(provider.readRelevantThreads({ ...request, cursor: { version: 1, accountId: request.accountId, mailboxSubject: 'other', mode: 'history', historyId: '10', pageToken: null, since: request.since } }, new AbortController().signal)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it('serializes real threaded send with exact RFC references and rejects CRLF before sending', async () => {
    const bodies: Record<string, string>[] = [];
    const fetch = transport((_url, init) => { bodies.push(JSON.parse(String(init?.body))); return { id: 'sent1', threadId: 't1' }; });
    const make = () => createPreparedGmailSender({ accountEmail: grant.email, accessToken: 'fixture', fetch, signal: new AbortController().signal, isCurrent: () => true });
    const email = { commandId: '11111111-1111-4111-8111-111111111111', from: grant.email, to: 'pm@fixture.invalid', subject: 'Re: hello', body: 'Hello', threadId: 't1', inReplyTo: '<m1@fixture.invalid>', references: ['<m0@fixture.invalid>', '<m1@fixture.invalid>'] };
    expect(await make().sendOnce(email)).toMatchObject({ status: 'accepted' });
    expect(bodies[0]?.threadId).toBe('t1');
    const mime = Buffer.from(bodies[0]?.raw ?? '', 'base64url').toString();
    expect(mime).toContain('In-Reply-To: <m1@fixture.invalid>\r\n');
    expect(mime).toContain('References: <m0@fixture.invalid> <m1@fixture.invalid>\r\n');
    const malicious = { ...email, inReplyTo: '<x>\r\nBcc: bad@fixture.invalid' };
    expect(await make().sendOnce(malicious)).toMatchObject({ status: 'not_sent' });
    expect(bodies).toHaveLength(1);
  });
});
it('expired history triggers bounded rescan and retains inert bounded HTML without attachments', async () => {
  const urls: URL[] = [];
  const fetch: typeof globalThis.fetch = (async (raw: string | URL | Request) => {
    const url = new URL(String(raw)); urls.push(url);
    if (url.pathname.endsWith('/history')) return new Response('', { status: 404 });
    if (url.pathname.endsWith('/profile')) return new Response(JSON.stringify({ historyId: '100' }));
    if (url.pathname.endsWith('/messages')) return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }));
    const m = metadata('m1');
    if (url.searchParams.get('format') === 'full') m.payload = { ...m.payload, mimeType: 'text/html', body: { data: Buffer.from('<script>steal()</script><b>abcd</b>éééé').toString('base64url') } };
    return new Response(JSON.stringify(m));
  }) as typeof fetch;
  const page = await createGmailThreadProvider({ now: () => Date.parse('2026-09-08T12:00:00.000Z'), grant, accessToken: 'fixture', fetch }).readRelevantThreads({ ...request, maxBodyBytes: 8, cursor: { version: 1, accountId: request.accountId, mailboxSubject: grant.subject, mode: 'history', historyId: '1', pageToken: null, since: request.since } }, new AbortController().signal);
  const part = page.threads[0]?.messages[0]?.bodyParts[0];
  expect(Buffer.byteLength(part?.text ?? '')).toBeLessThanOrEqual(8);
  expect(part?.text).not.toMatch(/steal|script|<b>/);
  expect(part?.truncated).toBe(true);
  expect(page.nextCursor).toMatchObject({ mode: 'history', historyId: '100', pageToken: null });
  expect(urls.filter(u => u.pathname.endsWith('/profile'))).toHaveLength(1);
});
it('clamps an unbounded initial window and rejects malformed base64 before retaining evidence', async () => {
  let query = '';
  const fetch = transport(url => {
    if (url.pathname.endsWith('/profile')) return { historyId: '10' };
    if (url.pathname.endsWith('/messages')) { query = url.searchParams.get('q') ?? ''; return { messages: [{ id: 'm1' }] }; }
    const m = metadata('m1'); if (url.searchParams.get('format') === 'full') m.payload.body.data = 'a'; return m;
  });
  const now = () => Date.parse('2026-09-08T12:00:00.000Z');
  const provider = createGmailThreadProvider({ now: () => Date.parse('2026-09-08T12:00:00.000Z'), grant, accessToken: 'fixture', fetch });
  await expect(provider.readRelevantThreads({ ...request, since: '1970-01-01T00:00:00.000Z' }, new AbortController().signal)).rejects.toThrow('invalid_mail_encoding');
  expect(query).toContain(`after:${Math.floor((now() - 30 * 86400000) / 1000)}`);
});
it('does not authorize dispatch after initial listing until captured history has been replayed', async () => {
  const fetch = transport(url => url.pathname.endsWith('/profile') ? { historyId: '10' } : url.pathname.endsWith('/history') ? { historyId: '11' } : {});
  const provider = createGmailThreadProvider({ now: () => Date.parse('2026-09-08T12:00:00.000Z'), grant, accessToken: 'fixture', fetch });
  const initial = await provider.readRelevantThreads(request, new AbortController().signal);
  expect(initial.complete).toBe(false);
  const caughtUp = await provider.readRelevantThreads({ ...request, cursor: initial.nextCursor }, new AbortController().signal);
  expect(caughtUp.complete).toBe(true);
  expect(caughtUp.nextCursor.historyId).toBe('11');
});
