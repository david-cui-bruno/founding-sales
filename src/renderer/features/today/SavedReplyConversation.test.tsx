// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { dailyAnswerSchema, type DailyAnswer } from '../../../shared/contracts/dailyContract';
import type { MailMessage } from '../../../shared/contracts/mailThreadContract';
import type { LinkedInApi } from '../../../shared/contracts/linkedInContract';
import type { RequestedDraftApi } from './requestedDraftSession';
import type { OrdinaryReplyApi } from './ordinaryReplySession';
import { answerKey, DailyAnswerDetail } from './DailyAnswers';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
type Reply = Extract<DailyAnswer, { kind: 'reply' }>;
const body = 'Hi Alex,\n\n  Could you share the original example?\n\tPlease keep this wording.  ';
function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'latest', threadId: 'thread-a', rfcMessageId: null, references: [],
    from: ['mira@larkspur.example'], to: ['alex@callie-demo.example'], cc: ['casey@larkspur.example'],
    date: '2026-09-15T13:15:00.000Z', subject: 'Question about shared enquiries',
    bodyParts: [{ mimeType: 'text/plain', text: body, truncated: false }], ...overrides,
  };
}
function reply(overrides: Partial<Reply> = {}): Reply {
  const value: Reply = {
    kind: 'reply', accountId: 'account-a', capability: 'held', reason: 'reply_capability_unverified', stale: false,
    thread: { revision: 1, contextRevision: 'context-a', signals: [], thread: {
      accountId: 'account-a', provider: 'gmail', mailboxSubject: 'mailbox-a', providerThreadId: 'thread-a',
      // Deliberately newest first: rendering must not rely on input order.
      messages: [message(), message({ id: 'earlier', date: '2026-09-14T18:10:00.000Z',
        from: ['alex@callie-demo.example'], to: ['mira@larkspur.example'], cc: [],
        bodyParts: [{ mimeType: 'text/plain', text: 'Earlier exact wording.', truncated: false }] })],
    } },
    draft: { id: 'draft-a', accountId: 'account-a', threadId: 'thread-a', mailboxSubject: 'mailbox-a',
      threadRevision: 1, contextRevision: 'context-a', revision: 1, recipient: 'mira@larkspur.example',
      sender: 'alex@callie-demo.example', subject: 'Re: Shared enquiries', body: 'Saved unsent response.',
      evidenceIds: [], generation: 'edited', updatedAt: '2026-09-15T14:00:00.000Z' },
    ...overrides,
  };
  expect(dailyAnswerSchema.safeParse(value).success).toBe(true);
  return value;
}
function fixture() {
  const forbidden = vi.fn((): never => { throw new Error('Unexpected API or network effect'); });
  const api = {
    getRequestedFollowup: forbidden, editRequestedFollowup: forbidden, approveRequestedFollowup: forbidden,
    editReplyDraft: forbidden, reconcileReplyDraft: forbidden,
  } satisfies RequestedDraftApi & OrdinaryReplyApi;
  const linkedin = {
    recover: forbidden, begin: forbidden, prepare: forbidden, save: forbidden,
    get: forbidden, open: forbidden, copy: forbidden, reportOutcome: forbidden,
  } satisfies LinkedInApi;
  vi.stubGlobal('fetch', forbidden);
  vi.stubGlobal('XMLHttpRequest', forbidden);
  vi.stubGlobal('WebSocket', forbidden);
  const view = (item: Reply) => {
    expect(dailyAnswerSchema.safeParse(item).success).toBe(true);
    return <DailyAnswerDetail item={item} workspaceId="workspace-a" api={api} linkedin={linkedin} company="Larkspur Studio" accountDetails={<p>Saved company context.</p>} />;
  };
  return { forbidden, view };
}
function conversation() { return screen.getByRole('region', { name: 'Saved conversation' }); }

it('shows the actual saved incoming conversation before the existing reply draft with latest open and earlier native disclosure', () => {
  const f = fixture();
  const item = reply();
  const original = structuredClone(item);
  render(f.view(item));
  const region = conversation();
  expect(screen.getByRole('heading', { name: /^Saved reply draft$/ })).toBeTruthy();
  expect(region.compareDocumentPosition(screen.getByText('Saved unsent response.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(region).getByText(/2 saved messages.*snapshot may be incomplete.*Remote freshness is unknown/)).toBeTruthy();
  const latest = within(region).getByText(/Latest saved message/).closest('details')!;
  const earlier = within(region).getByText('Earlier saved messages (1)').closest('details')!;
  expect(latest.open).toBe(true);
  expect(earlier.open).toBe(false);
  expect(latest.querySelector('pre')?.textContent).toBe(body);
  fireEvent.click(within(earlier).getByText('Earlier saved messages (1)'));
  expect(earlier.open).toBe(true);
  expect(within(earlier).getByText('Earlier exact wording.')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Reply approval held: an exact permission binding is unavailable here. Saving is not approval or sending.');
  expect(item).toEqual(original);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('renders saved participants, subject and a timezone-explicit timestamp without inventing names or active links', () => {
  const f = fixture();
  const item = reply();
  item.thread.thread.messages[0].from.push('operations@larkspur.example');
  render(f.view(reply(item)));
  const latest = within(conversation()).getByText(/Latest saved message/).closest('details')!;
  const metadata = latest.querySelector('dl')!;
  expect(metadata.textContent).toContain('mira@larkspur.example, operations@larkspur.example');
  expect(metadata.textContent).toContain('Toalex@callie-demo.example');
  expect(metadata.textContent).toContain('Cccasey@larkspur.example');
  expect(metadata.textContent).toContain('SubjectQuestion about shared enquiries');
  const time = metadata.querySelector('time')!;
  expect(time.dateTime).toBe('2026-09-15T13:15:00.000Z');
  expect(time.textContent).toContain('UTC');
  expect(time.textContent).toContain('2026');
  expect(latest.querySelectorAll('a,img,iframe,script')).toHaveLength(0);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it.each([false, true])('keeps the conversation available without a draft, stale=%s, and preserves the existing held wording', stale => {
  const f = fixture();
  const item = reply({ draft: null, stale });
  item.thread.thread.messages = [message()];
  render(f.view(item));
  expect(conversation().querySelector('pre')?.textContent).toBe(body);
  expect(screen.getByText(/1 saved message\./)).toBeTruthy();
  expect(screen.getByText('No earlier messages in this saved snapshot.')).toBeTruthy();
  expect(screen.getByText('No saved reply draft.')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('Reply approval held: an exact permission binding is unavailable here.');
  expect(screen.getByRole('status').textContent?.startsWith('Thread or context changed. ')).toBe(stale);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('prefers literal plain text over HTML and preserves whitespace and wrapping without parsing content', () => {
  const f = fixture();
  const item = reply();
  const text = '  <b>Literal</b>\n\nhttps://remote.example/' + 'long'.repeat(100) + '\n\tfinal  ';
  item.thread.thread.messages = [message({ bodyParts: [
    { mimeType: 'text/html', text: '<img src="https://remote.example/pixel" onerror="alert(1)">hidden HTML', truncated: false },
    { mimeType: 'text/plain', text, truncated: false },
  ] })];
  render(f.view(item));
  const region = conversation();
  const pre = region.querySelector('pre')!;
  expect(pre.textContent).toBe(text);
  expect(pre.style.whiteSpace).toBe('pre-wrap');
  expect(pre.style.overflowWrap).toBe('anywhere');
  expect(region.textContent).not.toContain('hidden HTML');
  expect(region.querySelectorAll('b,img,script,a,iframe')).toHaveLength(0);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('labels HTML-only escaped source, warns about truncation, and never activates malicious markup', () => {
  const f = fixture();
  const item = reply({ stale: true });
  const html = '<script>alert(1)</script><img src="https://remote.example/pixel"><a href="javascript:alert(2)">click</a>\n  &lt;literal&gt;';
  item.thread.thread.messages = [message({ bodyParts: [{ mimeType: 'text/html', text: html, truncated: true }] })];
  render(f.view(item));
  const region = conversation();
  expect(within(region).getByText(/HTML-only message.*escaped source.*not rendered/)).toBeTruthy();
  expect(region.querySelector('pre')?.textContent).toBe(html);
  expect(within(region).getByText(/saved body part is truncated/)).toBeTruthy();
  expect(region.querySelectorAll('img,script,a,iframe,object')).toHaveLength(0);
  expect(screen.getByText('Saved unsent response.')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('Thread or context changed.');
  expect(f.forbidden).not.toHaveBeenCalled();
});

it.each([{ bodyParts: [] }, { bodyParts: [{ mimeType: 'text/plain' as const, text: '', truncated: true }] }])('warns when no body text was saved and never invents content', ({ bodyParts }) => {
  const f = fixture();
  const item = reply();
  item.thread.thread.messages = [message({ bodyParts, to: [], cc: [], subject: '' })];
  render(f.view(item));
  expect(within(conversation()).getByText('No body text was saved for this message.')).toBeTruthy();
  expect(within(conversation()).getByText('No subject saved')).toBeTruthy();
  expect(conversation().querySelectorAll('pre')).toHaveLength(0);
  if (bodyParts.length) expect(within(conversation()).getByText(/saved body part is truncated/)).toBeTruthy();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('shows all saved plain parts literally and keeps a truncation warning even on an omitted alternative', () => {
  const f = fixture();
  const item = reply();
  item.thread.thread.messages = [message({ bodyParts: [
    { mimeType: 'text/plain', text: 'part one  ', truncated: false },
    { mimeType: 'text/plain', text: '\npart two', truncated: false },
    { mimeType: 'text/html', text: '<b>alternative</b>', truncated: true },
  ] })];
  render(f.view(item));
  expect([...conversation().querySelectorAll('pre')].map(p => p.textContent)).toEqual(['part one  ', '\npart two']);
  expect(within(conversation()).getByText(/saved body part is truncated/)).toBeTruthy();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('supports the actual 200-message bound and selects the latest timestamp without mutating saved order', () => {
  const f = fixture();
  const item = reply();
  item.thread.thread.messages = Array.from({ length: 200 }, (_, index) => message({
    id: `message-${index}`, date: new Date(Date.UTC(2026, 8, 15, 0, index)).toISOString(),
    bodyParts: [{ mimeType: 'text/plain', text: `Saved message ${index}`, truncated: false }],
  })).reverse();
  const original = structuredClone(item);
  render(f.view(reply(item)));
  const region = conversation();
  expect(within(region).getByText(/200 saved messages/)).toBeTruthy();
  expect(within(region).getByText('Earlier saved messages (199)')).toBeTruthy();
  const latest = within(region).getByText(/Latest saved message/).closest('details')!;
  expect(latest.querySelector('pre')?.textContent).toBe('Saved message 199');
  expect(region.querySelectorAll('pre')).toHaveLength(200);
  expect(item).toEqual(original);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it.each(['account', 'mailbox', 'thread', 'draft', 'draftless'] as const)('isolates message/disclosure selection when the %s identity changes on rerender', identity => {
  const f = fixture();
  const first = reply();
  const view = render(f.view(first));
  const oldLatest = within(conversation()).getByText(/Latest saved message/).closest('details')!;
  fireEvent.click(within(oldLatest).getByText(/Latest saved message/));
  expect(oldLatest.open).toBe(false);
  const oldEarlier = within(conversation()).getByText('Earlier saved messages (1)').closest('details')!;
  fireEvent.click(within(oldEarlier).getByText('Earlier saved messages (1)'));
  const next = structuredClone(first);
  if (identity === 'account') { next.accountId = 'account-b'; next.thread.thread.accountId = 'account-b'; next.draft!.accountId = 'account-b'; }
  if (identity === 'mailbox') { next.thread.thread.mailboxSubject = 'mailbox-b'; next.draft!.mailboxSubject = 'mailbox-b'; }
  if (identity === 'thread') { next.thread.thread.providerThreadId = 'thread-b'; next.draft!.threadId = 'thread-b'; next.thread.thread.messages.forEach(m => { m.threadId = 'thread-b'; }); }
  if (identity === 'draft') next.draft!.id = 'draft-b';
  if (identity === 'draftless') next.draft = null;
  next.thread.thread.messages[0].bodyParts[0].text = 'Different selection exact text.';
  expect(answerKey(next)).not.toBe(answerKey(first));
  view.rerender(f.view(reply(next)));
  const latest = within(conversation()).getByText(/Latest saved message/).closest('details')!;
  expect(latest).not.toBe(oldLatest);
  expect(latest.open).toBe(true);
  expect(within(conversation()).getByText('Earlier saved messages (1)').closest('details')!.open).toBe(false);
  expect(latest.querySelector('pre')?.textContent).toBe('Different selection exact text.');
  expect(conversation().textContent).not.toContain('Could you share the original example?');
  expect(screen.queryAllByRole('button').map(button => button.textContent)).toEqual(next.draft ? ['Edit saved reply', 'Reconcile saved reply'] : []);
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('preserves a native disclosure choice on the same selection but opens a newly saved latest message', () => {
  const f = fixture();
  const item = reply();
  const view = render(f.view(item));
  const latest = within(conversation()).getByText(/Latest saved message/).closest('details')!;
  fireEvent.click(within(latest).getByText(/Latest saved message/));
  view.rerender(f.view(structuredClone(item)));
  expect(within(conversation()).getByText(/Latest saved message/).closest('details')).toBe(latest);
  expect(latest.open).toBe(false);
  const next = structuredClone(item);
  next.thread.revision += 1;
  next.stale = true;
  next.thread.thread.messages.push(message({ id: 'new-latest', date: '2026-09-15T19:00:00.000Z',
    bodyParts: [{ mimeType: 'text/plain', text: 'Newer saved question.', truncated: false }] }));
  view.rerender(f.view(next));
  const changed = within(conversation()).getByText(/Latest saved message/).closest('details')!;
  expect(changed).not.toBe(latest);
  expect(changed.open).toBe(true);
  expect(changed.querySelector('pre')?.textContent).toBe('Newer saved question.');
  expect(within(conversation()).getByText('Earlier saved messages (2)')).toBeTruthy();
  expect(screen.getByText('Saved unsent response.')).toBeTruthy();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('uses stable saved order for equal timestamps and renders HTML source if the plain alternative is empty', () => {
  const f = fixture();
  const item = reply();
  const html = '<p>Unparsed &amp; unchanged</p>';
  item.thread.thread.messages = [message({ bodyParts: [
    { mimeType: 'text/plain', text: '', truncated: false },
    { mimeType: 'text/html', text: html, truncated: false },
  ] }), message({ id: 'same-date', bodyParts: [{ mimeType: 'text/plain', text: 'Same date, second saved position.', truncated: false }] })];
  render(f.view(item));
  const latest = within(conversation()).getByText(/Latest saved message/).closest('details')!;
  expect(latest.querySelector('pre')?.textContent).toBe(html);
  expect(within(latest).getByText(/HTML-only message/)).toBeTruthy();
  expect(latest.querySelector('pre p')).toBeNull();
  expect(within(conversation()).getByText('Earlier saved messages (1)').closest('details')?.textContent).toContain('Same date, second saved position.');
  expect(f.forbidden).not.toHaveBeenCalled();
});
