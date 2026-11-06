// @vitest-environment jsdom
import {priorityFixturePage} from './support/priorityFixture.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserApp } from '../../src/client/BrowserApp.tsx';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { CAMPAIGN_PENDING_KEY } from '../../src/client/CampaignPending.ts';
import { REPLY_PENDING_KEY } from '../../src/client/ReplyAttempt.ts';
import { PRIVATE_DRAFT_PENDING_KEY } from '../../src/client/PrivateDraftCustody.ts';
import { VOICE_PENDING_KEY } from '../../src/client/VoicePreferenceCustody.ts';
import { CALLING_PENDING_KEY, CallingCustody } from '../../src/client/CallingPending.ts';
import { CALLING_FOLLOW_UP_PENDING_KEY } from '../../src/client/CallingFollowUpPending.ts';
import { CALLING_EXECUTION_KEY } from '../../src/client/CallingExecutionPending.ts';

const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const card = { firmId: id, firmName: '<private firm>', lane: 'reply', dueAt: '2026-10-25T12:00:00.000Z', counts: { replies: 2, callsDue: 0, emailsDue: 1 } };
const today = { workspaceId: id, snapshotDate: '2026-10-25', businessTimeZone: 'America/New_York', cards: [card] };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
const clients: BrowserClient[] = [];
function setup() {
  let status: 'signed_in' | 'signed_out' = 'signed_in';
  let revision = 'one', role: 'admin' | 'member' = 'admin';
  let todayAnswer: unknown = today;
  let todayStatus = 200;
  let todayWait: PromiseWithResolvers<Response> | undefined;
  let sessionWait: PromiseWithResolvers<Response> | undefined;
  let firmWait: PromiseWithResolvers<Response> | undefined;
  let signoutFails = false;
  const navigate = vi.fn();
  const send = vi.fn<typeof fetch>(async url => {
    if (url === '/browser/session') return sessionWait ? await sessionWait.promise : json(status === 'signed_out' ? { status, csrfToken: 'c'.repeat(40) } : { status, workspaceId: id, userId: id, deviceId: id, role, revision, csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() });
    if (url === '/browser/api/today/actions/v4?include=callingPreparation') return json({ version: 4, workspaceId: id, businessTimeZone: 'America/New_York', asOf: '2026-10-25T12:00:00.000Z', actions: [], promiseCoverage: { scope: 'current_authorized_work', truncated: false, nextAfterId: null } });
    if (url === '/browser/api/calling/setup') return json({ callingProvider: { provider: 'tel', version: 0 }, telephonyBudget: { version: 0, dailyCeilingCents: 0, maxMinutesPerCall: 30, unitPriceMicros: 14000 }, configured: false, spentTodayCents: 0 });
    if (url === '/browser/api/calling-identities') return json({identities:[]});
    if (url === '/browser/api/social/private-drafts/list') return json({ drafts: [], nextAfterId: null });
    if (String(url).startsWith('/browser/api/today?')) {
      const held = todayWait; todayWait = undefined;
      return held ? await held.promise : json(todayAnswer, todayStatus);
    }
    if (url === '/browser/api/crm/firm-page-v3' && firmWait) return await firmWait.promise;
    if (url === '/browser/api/sourcing/candidates/prospects/priority/list') return json(priorityFixturePage({ prospects: [], hasMore: false }));
    if (url === '/browser/api/sourcing/prepared-prospects/list') return json({prospects:[],hasMore:false,viewRevision:'a'.repeat(64),checkedAt:new Date().toISOString()});
    if (url === '/browser/sign-in') return json({ authorizationUrl: 'https://login.example.test/authorize' });
    if (url === '/browser/sign-out') {
      if (signoutFails) throw Error('uncertain');
      status = 'signed_out'; return json({ status, csrfToken: 'c'.repeat(40) });
    }
    throw Error('Unexpected test transport route');
  });
  const client = new BrowserClient({ fetch: send, storage: sessionStorage, manualActivityStorage: localStorage, navigate, randomUUID: () => other });
  clients.push(client);
  return { client, send, navigate,
    answer: (answer: unknown, code = 200) => { todayAnswer = answer; todayStatus = code; },
    anonymous: () => { status = 'signed_out'; }, changeRevision: () => { revision = 'two'; }, member: () => { role = 'member'; },
    delayToday: () => { todayWait = Promise.withResolvers<Response>(); return todayWait; },
    delaySession: () => { sessionWait = Promise.withResolvers<Response>(); return sessionWait; },
    delayFirm: () => { firmWait = Promise.withResolvers<Response>(); return firmWait; },
    uncertainLogout: () => { signoutFails = true; },
  };
}
function navigate(name: string): void { fireEvent.click(within(screen.getByRole('navigation', { name: 'Workspace sections' })).getByRole('button', { name })); }
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.dispose(); sessionStorage.clear(); localStorage.clear(); });

describe('issue787 mounted real-client shell', () => {
  it('composes the committed single-page feature workspaces without legacy stacked mounts or writes', async () => {
    const s = setup(); render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
    navigate('Prospects');
    await screen.findByRole('region', { name: 'Prepared company research' });
    await screen.findByText('0 prepared · 0 need research on this page. This is research supply, not a contact-ready count.');
    expect(screen.getByRole('region', { name: 'Prospects workspace' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Manual prospect worklist' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retained review' }));
    await screen.findByRole('region', { name: 'Manual prospect worklist' });
    expect(screen.queryByRole('region', { name: 'Prepared company research' })).toBeNull();
    navigate('Email');
    expect(screen.getByRole('region', { name: 'Email workspace' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Email views' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Prospects workspace' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Automatic outreach' }));
    expect(screen.queryByRole('region', { name: 'Replies' })).toBeNull();
    navigate('Social');
    expect(screen.getByRole('region', { name: 'Social workspace' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Drafts' }));
    await screen.findByText('No saved private drafts. Start a new manual draft.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Private social text' }), { target: { value: 'Unsaved private text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Conversations' }));
    expect(screen.getByRole('region', { name: 'Retained public conversations' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read retained public threads' }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Private social text' })).toBeNull();
    navigate('Prospects');
    expect(screen.getByRole('heading', { name: 'Prospects', level: 1 })).toBeTruthy();
    expect(screen.queryByText('Unsaved private text')).toBeNull();
    await waitFor(() => expect(s.send.mock.calls.filter(([url]) => url === '/browser/api/sourcing/prepared-prospects/list')).toHaveLength(2));
    const routes = s.send.mock.calls.map(([url]) => String(url));
    const preparedReads=s.send.mock.calls.filter(([url])=>url==='/browser/api/sourcing/prepared-prospects/list');
    expect(preparedReads.map(([,init])=>[init?.method,JSON.parse(String(init?.body))])).toEqual([['POST',{offset:0}],['POST',{offset:0}]]);
    expect(routes.filter(url => url === '/browser/api/social/private-drafts/list')).toHaveLength(1);
    // Browser calling setup and the calling identity are Settings or selected-company reads, never a bare Prospects mount.
    expect(routes).not.toContain('/browser/api/calling/setup');
    expect(routes).not.toContain('/browser/api/calling-identities');
  });
  it('mounts only real Today, escapes content and uses the shared four destinations', async () => {
    const s = setup(); render(<BrowserApp client={s.client} />);
    await screen.findByText(card.firmName);
    expect(within(screen.getByRole('navigation')).getAllByRole('button').map(button => button.textContent)).toEqual(['Today', 'Prospects', 'Email', 'Social']);
    expect(within(screen.getByRole('navigation')).getByRole('button', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
    expect(s.send.mock.calls.every(([url]) => url === '/browser/session' || String(url).startsWith('/browser/api/today?'))).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Replies' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /social/iu })).toBeNull();
  });
  it('keeps Prospects honest and dispatches no selection/readiness/provider/dial request', async () => {
    const s = setup(); render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
    const count = s.send.mock.calls.length; navigate('Prospects');
    expect(screen.getByRole('heading', { name: 'Prospects', level: 1 })).toBeTruthy();
    await screen.findByRole('region', { name: 'Prepared company research' });
    expect(screen.queryByRole('region', { name: 'Current calling brief' })).toBeNull();
    expect(screen.queryByRole('button', { name: /start call/iu })).toBeNull();
    expect(screen.queryByText(card.firmName)).toBeNull();
    expect(s.send.mock.calls.slice(count).every(([url, init]) => url === '/browser/session' || (url === '/browser/api/sourcing/prepared-prospects/list' && init?.method === 'POST'))).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
  it('switches day/night in the shell and settings without storing private or preference state', async () => {
    const s = setup(); const ui = render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
    const before = sessionStorage.length + localStorage.length;
    fireEvent.click(screen.getByRole('button', { name: 'Night mode' }));
    expect(ui.container.firstElementChild?.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Settings & account' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByText(id)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(ui.container.firstElementChild?.getAttribute('data-theme')).toBe('light');
    expect(sessionStorage.length + localStorage.length).toBe(before);
  });
  it('supports number navigation and settings keyboard shortcut, not typing or modifiers', async () => {
    const s = setup(); render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
    fireEvent.keyDown(document.body, { key: '2' });
    expect(screen.getByRole('heading', { name: 'Prospects', level: 1 })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: '5' });
    expect(screen.getByRole('heading', { name: 'Prospects', level: 1 })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: '1', ctrlKey: true });
    expect(screen.getByRole('heading', { name: 'Prospects', level: 1 })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: ',', metaKey: true });
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    const input = document.createElement('input'); document.body.append(input);
    fireEvent.keyDown(input, { key: '1' });
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy(); input.remove();
    const editor = document.createElement('div'); editor.setAttribute('contenteditable', 'true'); document.body.append(editor);
    fireEvent.keyDown(editor, { key: '2' });
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy(); editor.remove();
  });
  it('distinguishes loading, empty and refused instead of inventing counts or retrying', async () => {
    const s = setup(); const held = s.delayToday(); render(<BrowserApp client={s.client} />);
    await screen.findByText('Loading Today…');
    expect(screen.queryByText(/No firms need attention/u)).toBeNull();
    expect(screen.queryByText(/firms in this snapshot/u)).toBeNull();
    await act(async () => { held.resolve(json({ ...today, cards: [] })); });
    await screen.findByText('No firms need attention in this snapshot.');
    expect(screen.queryByRole('button', { name: `Open ${card.firmName}` })).toBeNull();
  });
  it('refused/unavailable read clears the previous snapshot and stops, explicit refresh recovers', async () => {
    const s = setup(); render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
    s.answer({}, 500); fireEvent.click(screen.getByRole('button', { name: 'Refresh Today' }));
    await screen.findByText(/Current view unavailable or refused/u);
    expect(screen.queryByText(card.firmName)).toBeNull();
    expect(screen.queryByText(/No firms need attention/u)).toBeNull();
    expect(s.send.mock.calls.filter(([url]) => String(url).startsWith('/browser/api/today?'))).toHaveLength(2);
    s.answer(today); fireEvent.click(screen.getByRole('button', { name: 'Refresh Today' }));
    await screen.findByText(card.firmName);
  });
  it('refuses a valid-schema snapshot from another workspace', async () => {
    const s = setup(); s.answer({ ...today, workspaceId: other }); render(<BrowserApp client={s.client} />);
    await screen.findByText(/Current view unavailable or refused/u);
    expect(screen.queryByText(card.firmName)).toBeNull();
  });
  it.each([401, 403, 409])('clears private views on %s and fences malformed inactive Calling custody', async code => {
    const s = setup(); render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
    localStorage.setItem(PRIVATE_DRAFT_PENDING_KEY, 'inactive-ids-only'); localStorage.setItem(VOICE_PENDING_KEY, 'inactive-ids-only');
    sessionStorage.setItem(CAMPAIGN_PENDING_KEY, 'inactive-ids-only'); sessionStorage.setItem(REPLY_PENDING_KEY, 'inactive-ids-only');
    localStorage.setItem(CALLING_PENDING_KEY, 'inactive-ids-only'); localStorage.setItem(CALLING_FOLLOW_UP_PENDING_KEY, 'inactive-ids-only');
    s.answer({}, code); fireEvent.click(screen.getByRole('button', { name: 'Refresh Today' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByText(card.firmName)).toBeNull();
    expect(localStorage.getItem(PRIVATE_DRAFT_PENDING_KEY)).toBeNull(); expect(localStorage.getItem(VOICE_PENDING_KEY)).toBeNull();
    expect(sessionStorage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull(); expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBeNull();
    // Malformed shared custody stays fail-closed instead of erasing uncertain writes.
    expect(localStorage.getItem(CALLING_PENDING_KEY)).toBe('inactive-ids-only');
    expect(new CallingCustody(s.client).all()).toEqual([]);
    expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBeNull();
  });
  it.each([401, 403, 409])('clears valid offscreen execution custody on %s without dispatch or replay', async code => {
    const prior = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, work: () => unknown) => work() } });
    try {
      const s = setup(); const view = render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
      const current = s.client.current;
      if (current?.status !== 'signed_in') throw Error('Expected current test session');
      const bytes = JSON.stringify([{ identity: JSON.stringify([current.workspaceId, current.userId, current.deviceId, current.role, current.revision]), expiresAt: current.expiresAt, operation: 'create_session', commandId: other, payloadSHA256: 'a'.repeat(64), firmId: id, routeId: id, routeVersion: 1, callingIdentityId: id }]);
      localStorage.setItem(CALLING_EXECUTION_KEY, bytes);
      navigate('Social'); await screen.findByRole('heading', { name: 'Social' });
      expect(localStorage.getItem(CALLING_EXECUTION_KEY)).toBe(bytes);
      s.answer({}, code); navigate('Today');
      await screen.findByRole('heading', { name: 'Sign in' });
      await waitFor(() => expect(JSON.parse(localStorage.getItem(CALLING_EXECUTION_KEY) ?? '[]')).toEqual([]));
      expect(s.send.mock.calls.some(([url]) => /\/calls\/|\/calling\/execution/u.test(String(url)))).toBe(false);
      view.unmount();
    } finally {
      if (prior) Object.defineProperty(navigator, 'locks', prior); else Reflect.deleteProperty(navigator, 'locks');
    }
  });
  it('ignores late Today after page navigation, then loads a fresh Today on return', async () => {
    const s = setup(); const held = s.delayToday(); render(<BrowserApp client={s.client} />); await screen.findByText('Loading Today…');
    navigate('Prospects'); await act(async () => { held.resolve(json(today)); });
    expect(screen.queryByText(card.firmName)).toBeNull(); navigate('Today'); await screen.findByText(card.firmName);
    expect(s.send.mock.calls.filter(([url]) => String(url).startsWith('/browser/api/today?'))).toHaveLength(2);
  });
  it('ignores late Firm after navigation without replacing the new page', async () => {
    const s = setup(); const held = s.delayFirm(); render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
    fireEvent.click(screen.getByRole('button', { name: `Open ${card.firmName}` }));
    await waitFor(() => { expect(s.send.mock.calls.some(([url]) => url === '/browser/api/crm/firm-page-v3')).toBe(true); });
    navigate('Prospects'); await act(async () => { held.resolve(json({})); });
    expect(screen.getByRole('heading', { name: 'Prospects', level: 1 })).toBeTruthy();
    expect(screen.queryByText(/Current view unavailable/u)).toBeNull();
  });
  it('does not dispatch a Firm read after navigation during its session wait', async () => {
    const s = setup(); render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
    const held = s.delaySession(); fireEvent.click(screen.getByRole('button', { name: `Open ${card.firmName}` })); navigate('Prospects');
    await act(async () => { held.resolve(json({ status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() })); });
    expect(s.send.mock.calls.some(([url]) => url === '/browser/api/crm/firm-page-v3')).toBe(false);
  });
  it.each(['revision', 'role'] as const)('clears views on changed %s instead of publishing under the new identity', async kind => {
    const s = setup(); render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
    if (kind === 'revision') s.changeRevision(); else s.member();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Today' })); await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByText(card.firmName)).toBeNull();
    expect(s.send.mock.calls.filter(([url]) => String(url).startsWith('/browser/api/today?'))).toHaveLength(1);
  });
  it('reports uncertain logout honestly and clears private content immediately', async () => {
    const s = setup(); s.uncertainLogout(); render(<BrowserApp client={s.client} />); await screen.findByText(card.firmName);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.queryByText(card.firmName)).toBeNull(); await screen.findByText(/Remote sign-out was not confirmed/u);
  });
  it('retains actual sign-in flow with no private feature mounted before authentication', async () => {
    const s = setup(); s.anonymous(); render(<BrowserApp client={s.client} />); await screen.findByRole('heading', { name: 'Sign in' });
    fireEvent.change(screen.getByLabelText('Workspace ID'), { target: { value: id } });
    fireEvent.change(screen.getByLabelText('Browser label'), { target: { value: 'Synthetic test browser' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => { expect(s.navigate).toHaveBeenCalledWith('https://login.example.test/authorize'); });
    expect(s.send.mock.calls.every(([url]) => url === '/browser/session' || url === '/browser/sign-in')).toBe(true);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
