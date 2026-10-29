// @vitest-environment jsdom
import {priorityFixturePage} from './support/priorityFixture.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { callingSetupSchema, callingWrapInputSchema } from '@fss/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserApp } from '../../src/client/BrowserApp.tsx';
import { BrowserToday } from '../../src/client/BrowserToday.tsx';
import * as EmailWorkspace from '../../src/client/BrowserEmailWorkspace.tsx';
import * as ProspectsWorkspace from '../../src/client/BrowserProspectsWorkspace.tsx';
import type { EmailWorkspaceProps, WorkspaceScreenProps } from '../../src/client/workspaceNavigation.ts';
import { BrowserClient, PENDING_KEY } from '../../src/client/BrowserClient.ts';
import { REPLY_PENDING_KEY } from '../../src/client/ReplyAttempt.ts';
import { CALLING_PENDING_KEY } from '../../src/client/CallingPending.ts';
import { CALLING_FOLLOW_UP_PENDING_KEY } from '../../src/client/CallingFollowUpPending.ts';

const id = '00000000-0000-4000-8000-000000000001';
const session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'revision-one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() };
const firm = { id, name: 'Synthetic Alpha Firm', website: null, locality: null, regionCode: null, status: 'active', assignedUserId: id, stageKey: null, opportunityStatus: null, controlMode: null, openedAt: null, timeZone: null, timeZoneUnresolvedReason: null, addressLine: null, postalCode: null, countryCode: 'US', timeZoneConfidence: null, timeZoneSource: null, contacts: [{ id, fullName: 'Fixture Person', title: 'Owner', status: 'active', isPrimary: true }], phoneRoutes: [], emailRoutes: [], aliases: [] };
const notes = { meetingId: id, revision: 0, debrief: '', speakerMappings: [], itemOverrides: [], sufficient: false, savedAt: null };
const outcomes = { meetingId: id, firmId: id, notes, analysisId: null, sourceHash: 'a'.repeat(64), state: 'empty', attendance: 'unconfirmed', overview: '', items: [], tasks: [], holds: [] };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
function setup() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const commands: unknown[] = [];
  let loseResponse = false;
  let loseWrap = false, loseFollowUp = false;
  let promised: { draftId: string; subject: string; body: string } | null = null;
  const metadata = () => promised ? { draftId: promised.draftId, revision: 1, source: { kind: 'firm', firmId: id, callLogId: id }, availability: 'available', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' } : null;
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json(session);
    if (url === '/browser/sign-out') return json({ status: 'signed_out', csrfToken: 'a'.repeat(40) });
    if (url === '/browser/api/today/actions/v4') return json({ version: 4, workspaceId: id, businessTimeZone: 'America/New_York', asOf: '2026-10-25T12:00:00.000Z', actions: [], promiseCoverage: { scope: 'current_authorized_work', truncated: false, nextAfterId: null } });
    if (String(url).startsWith('/browser/api/today')) return json({ workspaceId: id, snapshotDate: '2026-10-22', businessTimeZone: 'America/New_York', cards: [{ firmId: id, firmName: firm.name, lane: 'new_firm', dueAt: '2026-10-22T00:00:00.000Z', counts: { replies: 0, emailsDue: 0, callsDue: 0 } }] });
    if (url === '/browser/api/sourcing/candidates/prospects/priority/list') return json(priorityFixturePage({ prospects: [], hasMore: false }));
    if (url === '/browser/api/crm/firm-page-v3') return json({ version: 3, visibility: 'assigned_or_admin', read: { visibility: 'assigned_or_admin', firm }, opportunities: [], holds: [], followUpPermissions: [] });
    if (url === '/browser/api/calling-identities') return json({ identities: [] });
    if (url === '/browser/api/calling/setup') return json(callingSetupSchema.parse({ callingProvider: { provider: 'tel', version: 4 }, telephonyBudget: { dailyCeilingCents: 500, maxMinutesPerCall: 4, unitPriceMicros: 14000, version: 3 }, spentTodayCents: 0, configured: true }));
    if (url === '/browser/api/calling/wrap') {
      const { commandId, ...payload } = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(commandId).toBeTruthy(); expect(localStorage.getItem(CALLING_PENDING_KEY)).toContain(commandId);
      const input = callingWrapInputSchema.parse(payload); commands.push(input);
      if (input.kind !== 'firm') throw Error('Only exact Firm fixture supported');
      if (input.promisedEmail) promised = input.promisedEmail;
      if (loseWrap) throw Error('Lost wrap response');
      return json({ status: 'accepted', replayed: false, result: { kind: 'firm', firmId: input.firmId, callLogId: id, staleIntroductions: 'stopped', attention: [], followUp: promised ? { state: 'queued_for_review', draftId: promised.draftId, revision: 1 } : { state: 'not_requested' } } });
    }
    if (url === '/browser/api/calling/follow-ups/list') return json({ drafts: promised ? [metadata()] : [], nextAfterId: null });
    if (url === '/browser/api/calling/follow-ups/read' && promised) {
      const input = JSON.parse(String(init?.body)) as { draftId: string; expectedRevision: number };
      expect(input).toEqual({ draftId: promised.draftId, expectedRevision: 1 });
      return json({ draft: { ...metadata(), content: { subject: promised.subject, body: promised.body }, state: 'queued_for_review', recipient: 'unresolved', sendAuthority: 'not_granted' } });
    }
    if (url === '/browser/api/calling/follow-ups/save') {
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toContain(input['commandId']); commands.push(input);
      if (loseFollowUp) throw Error('Lost follow-up response');
      throw Error('Unexpected successful follow-up mutation');
    }
    if (String(url).startsWith('/browser/api/meetings/outcomes')) return json(outcomes);
    if (url === '/browser/api/meetings/notes') {
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(storage.getItem(PENDING_KEY)).not.toBeNull();
      commands.push(command);
      if (loseResponse) throw new Error('lost');
      return json({ status: 'accepted', replayed: commands.length > 1, result: { ...notes, revision: 1, debrief: command['debrief'], sufficient: command['sufficient'], savedAt: '2026-10-22T01:00:00.000Z' } });
    }
    throw new Error('Unexpected route');
  });
  const client = new BrowserClient({ fetch: send, storage, navigate: vi.fn(), randomUUID: () => id });
  return { client, storage, commands, send, lose: () => { loseResponse = true; }, recover: () => { loseResponse = false; },
    loseWrap: () => { loseWrap = true; }, loseFollowUp: () => { loseFollowUp = true; },
    seedDraft: () => { promised = { draftId: id, subject: 'Existing promised material', body: 'Existing private promise' }; },
  };
}
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); });
function navigate(name: string): void {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Workspace sections' })).getByRole('button', { name }));
}
async function openNotes(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Open firm' }));
  await screen.findByText('Fixture Person · Owner');
  fireEvent.click(screen.getByRole('button', { name: 'Meeting notes' }));
  fireEvent.change(screen.getByLabelText('Meeting ID'), { target: { value: id } });
  fireEvent.click(screen.getByRole('button', { name: 'Read meeting notes' }));
  await screen.findByLabelText('Your notes');
}

describe('BrowserApp real shared presentation', () => {
  describe('actual Calling composition', () => {
    beforeEach(() => {
      vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder);
      Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name: string, _options: unknown, work: () => Promise<unknown>) => work()) } });
    });
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, 'locks'); });
    async function openActualCalling(client: BrowserClient): Promise<void> {
      render(<BrowserApp client={client} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Open firm' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Open calling brief' }));
      await waitFor(() => { expect(screen.getByLabelText('Actual outcome').matches(':disabled')).toBe(false); });
    }
    it('opens the accepted exact promised draft in the real Email editor with current revision, never sends', async () => {
      const s = setup();
      try {
        await openActualCalling(s.client);
        fireEvent.change(screen.getByLabelText('Actual outcome'), { target: { value: 'interested' } });
        fireEvent.change(screen.getByLabelText('Private call notes'), { target: { value: 'PRIVATE internal context' } });
        fireEvent.change(screen.getByLabelText('Next action'), { target: { value: 'promised_email' } });
        fireEvent.change(screen.getByLabelText('Promised email subject'), { target: { value: 'Independent promised material' } });
        fireEvent.change(screen.getByLabelText('Promised email body'), { target: { value: 'Independently written recipient-facing body' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /I personally performed/u }));
        fireEvent.click(screen.getByRole('button', { name: 'Save outcome and promised email' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Review promised email in Email →' }));
        const body = await screen.findByRole('textbox', { name: 'Follow-up body' });
        expect((body as HTMLTextAreaElement).value).toBe('Independently written recipient-facing body');
        expect(screen.getByRole('region', { name: 'Email workspace' })).toBeTruthy();
        expect(screen.queryByRole('region', { name: 'Current calling brief' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Follow-ups' }).getAttribute('aria-pressed')).toBe('true');
        const input = callingWrapInputSchema.parse(s.commands[0]);
        expect(input.kind).toBe('firm');
        expect(JSON.stringify(input.promisedEmail)).not.toContain('PRIVATE');
        const draftId = input.promisedEmail!.draftId;
        const reads = s.send.mock.calls.filter(([url]) => url === '/browser/api/calling/follow-ups/read');
        expect(reads).toHaveLength(2);
        for (const [, init] of reads) expect(JSON.parse(String(init?.body))).toEqual({ draftId, expectedRevision: 1 });
        expect(s.commands).toHaveLength(1);
        expect(s.send.mock.calls.some(([url]) => /send|dial|reserve|provider/u.test(String(url)))).toBe(false);
      } finally { s.client.dispose(); }
    });
    it('retains both real UNKNOWN commands across page unmounts and physically clears them on offscreen auth invalidation', async () => {
      const s = setup(); s.loseWrap(); s.loseFollowUp();
      try {
        await openActualCalling(s.client);
        fireEvent.change(screen.getByLabelText('Actual outcome'), { target: { value: 'no_answer' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /I personally performed/u }));
        fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }));
        await screen.findByText('Outcome UNKNOWN for this exact subject.');
        const wrap = localStorage.getItem(CALLING_PENDING_KEY); expect(wrap).not.toBeNull();
        s.seedDraft(); navigate('Email');
        expect(localStorage.getItem(CALLING_PENDING_KEY)).toBe(wrap);
        fireEvent.click(screen.getByRole('button', { name: 'Follow-ups' }));
        fireEvent.click(await screen.findByRole('button', { name: /Draft 00000000/u }));
        const body = await screen.findByRole('textbox', { name: 'Follow-up body' });
        fireEvent.change(body, { target: { value: 'PRIVATE uncertain edit' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save private follow-up' }));
        await screen.findByText(/Save outcome UNKNOWN. Exact command retained/u);
        const followUp = localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY); expect(followUp).not.toBeNull();
        navigate('Today'); await screen.findByRole('button', { name: 'Open firm' });
        expect(localStorage.getItem(CALLING_PENDING_KEY)).toBe(wrap);
        expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe(followUp);
        expect(`${wrap}${followUp}`).not.toContain('PRIVATE');
        const writes = s.commands.length, requests = s.send.mock.calls.length;
        act(() => { s.client.invalidate(); });
        expect(localStorage.getItem(CALLING_PENDING_KEY)).toBeNull();
        expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBeNull();
        expect(s.commands).toHaveLength(writes); expect(s.send).toHaveBeenCalledTimes(requests);
        expect(screen.queryByRole('textbox', { name: 'Follow-up body' })).toBeNull();
      } finally { s.client.dispose(); }
    });
    it('app cleanup only unsubscribes the new custody observers without erasing uncertainty', async () => {
      const s = setup(); const ui = render(<BrowserApp client={s.client} />); await screen.findByRole('button', { name: 'Open firm' });
      localStorage.setItem(CALLING_PENDING_KEY, 'opaque-calling-unknown'); localStorage.setItem(CALLING_FOLLOW_UP_PENDING_KEY, 'opaque-follow-up-unknown');
      ui.unmount();
      expect(localStorage.getItem(CALLING_PENDING_KEY)).toBe('opaque-calling-unknown');
      expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe('opaque-follow-up-unknown');
      s.client.invalidate();
      expect(localStorage.getItem(CALLING_PENDING_KEY)).toBe('opaque-calling-unknown');
      expect(localStorage.getItem(CALLING_FOLLOW_UP_PENDING_KEY)).toBe('opaque-follow-up-unknown'); s.client.dispose();
    });
  });
  describe('exact navigation', () => {
    it('opens only the current exact Firm with current reads, no command or calling-readiness claim', async () => {
      const { client, send, storage } = setup(); render(<BrowserApp client={client} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Open firm' }));
      const open = await screen.findByRole('button', { name: 'Open calling brief' });
      const before = send.mock.calls.length;
      fireEvent.click(open);
      await screen.findByRole('heading', { name: firm.name, level: 2 });
      expect(screen.getByRole('button', { name: 'Check call readiness' })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'After your conversation' })).toBeTruthy();
      expect(send.mock.calls.slice(before).every(([url, init]) => url === '/browser/session' || url === '/browser/api/today/actions/v4' || url === '/browser/api/crm/firm-page-v3' || url === '/browser/api/calling-identities' || (url === '/browser/api/calling/setup' && (init?.method ?? 'GET') === 'GET' && init?.body === undefined))).toBe(true);
      expect(storage.getItem(PENDING_KEY)).toBeNull();
      expect(sessionStorage.length + localStorage.length).toBe(0);
      navigate('Email'); navigate('Calling');
      await screen.findByRole('heading', { name: firm.name, level: 2 });
      client.dispose();
    });
    it('keeps exact candidate/revision selection across pages and clears it after a new auth epoch', async () => {
      let oldOpen: WorkspaceScreenProps['onOpenCalling'];
      const probe = vi.spyOn(ProspectsWorkspace, 'BrowserProspectsWorkspace').mockImplementation(({ onOpenCalling }: WorkspaceScreenProps) => {
        oldOpen = onOpenCalling;
        return <><button onClick={() => { onOpenCalling?.({ kind: 'candidate', candidateId: id, expectedCandidateRevision: 7 }); }}>Exact candidate</button><button onClick={() => { onOpenCalling?.({ kind: 'candidate', candidateId: id, expectedCandidateRevision: 0 }); }}>Invalid candidate</button></>;
      });
      const { client, send } = setup();
      try {
        render(<BrowserApp client={client} />); await screen.findByRole('button', { name: 'Open firm' });
        navigate('Prospects'); const before = send.mock.calls.length;
        fireEvent.click(screen.getByRole('button', { name: 'Invalid candidate' }));
        expect(screen.queryByRole('heading', { name: 'Calling' })).toBeNull(); expect(send).toHaveBeenCalledTimes(before);
        fireEvent.click(screen.getByRole('button', { name: 'Exact candidate' }));
        await screen.findByRole('heading', { name: 'Selected retained observation' });
        await waitFor(() => expect(send.mock.calls.slice(before).filter(([url]) => url === '/browser/api/calling-identities')).toHaveLength(1));
        expect(send.mock.calls.slice(before).every(([url, init]) => url === '/browser/session' || url === '/browser/api/today/actions/v4' || url === '/browser/api/sourcing/candidates/prospects/priority/list' || url === '/browser/api/sourcing/candidates/prospects/list' || ((url === '/browser/api/calling/setup' || url === '/browser/api/calling-identities') && (init?.method ?? 'GET') === 'GET' && init?.body === undefined))).toBe(true);
        navigate('Email'); navigate('Calling');
        await screen.findByRole('heading', { name: 'Selected retained observation' });
        await act(async () => { client.invalidate(); await client.refresh(); });
        act(() => { oldOpen?.({ kind: 'candidate', candidateId: id, expectedCandidateRevision: 7 }); });
        navigate('Calling'); expect(screen.queryByRole('region', { name: 'Current calling brief' })).toBeNull();
      } finally { probe.mockRestore(); client.dispose(); }
    });
    it('passes memory-only Email selection props and clears them on logout and reauthentication', async () => {
      let oldSelect: EmailWorkspaceProps['onFollowUpDraftSelectionChange'];
      const probe = vi.spyOn(EmailWorkspace, 'BrowserEmailWorkspace').mockImplementation(({ selectedFollowUpDraftId, onFollowUpDraftSelectionChange }: EmailWorkspaceProps) => {
        oldSelect = onFollowUpDraftSelectionChange;
        return <div><p>Draft selection: {selectedFollowUpDraftId ?? 'none'}</p><button onClick={() => { onFollowUpDraftSelectionChange?.(id); }}>Choose exact draft</button></div>;
      });
      const { client, send } = setup();
      try {
        render(<BrowserApp client={client} />); await screen.findByRole('button', { name: 'Open firm' });
        navigate('Email'); const before = send.mock.calls.length; fireEvent.click(screen.getByRole('button', { name: 'Choose exact draft' }));
        expect(screen.getByText(`Draft selection: ${id}`)).toBeTruthy(); expect(send).toHaveBeenCalledTimes(before);
        navigate('Calling'); navigate('Email'); expect(screen.getByText(`Draft selection: ${id}`)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); await screen.findByRole('heading', { name: 'Sign in' });
        await act(async () => { await client.refresh(); });
        act(() => { oldSelect?.(id); }); navigate('Email');
        expect(screen.getByText('Draft selection: none')).toBeTruthy();
      } finally { probe.mockRestore(); client.dispose(); }
    });
    it('synchronously refuses the opened Firm callback on expiry before React removes the view', async () => {
      const { client, send } = setup(); await client.refresh(); const onOpenCalling = vi.fn();
      render(<BrowserToday client={client} onOpenCalling={onOpenCalling} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Open firm' }));
      const open = await screen.findByRole('button', { name: 'Open calling brief' });
      const before = send.mock.calls.length;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180_000);
      try { fireEvent.click(open); expect(onOpenCalling).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(before); }
      finally { clock.mockRestore(); client.dispose(); }
    });
  });
  it('opens Today alone and retains manual prospects and ordinary inventory behind explicit destinations', async () => {
    const { client, commands, send } = setup();
    render(<BrowserApp client={client} />);
    await screen.findByRole('button', { name: 'Open firm' });
    expect(screen.queryByRole('heading', { name: 'Ordinary sourcing inventory' })).toBeNull();
    expect(send.mock.calls.some(([url]) => url === '/browser/api/sourcing/candidates/prospects/priority/list')).toBe(false);
    navigate('Prospects');
    await screen.findByRole('region', { name: 'Prepared source-backed supply' });
    expect(send.mock.calls.some(([url]) => url === '/browser/api/sourcing/candidates/prospects/priority/list')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retained review' }));
    expect(send.mock.calls.some(([url]) => url === '/browser/api/sourcing/candidates/list')).toBe(false);
    await waitFor(() => { expect(send.mock.calls.some(([url]) => url === '/browser/api/sourcing/candidates/prospects/priority/list')).toBe(true); });
    expect(send.mock.calls.some(([url]) => String(url).includes('/sourcing/qualification/'))).toBe(false);
    expect(commands).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Source inventory' }));
    await screen.findByRole('heading', { name: 'Ordinary sourcing inventory' });
    expect(screen.queryByRole('region', { name: 'Selected prospect inspector' })).toBeNull();
    navigate('Today');
    fireEvent.click(await screen.findByRole('button', { name: 'Open firm' }));
    await screen.findByText('Fixture Person · Owner');
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('heading', { name: firm.name })); });
    expect(screen.queryByRole('heading', { name: 'Ordinary sourcing inventory' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '← Back to Today' }));
    await screen.findByRole('button', { name: 'Open firm' });
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Today' })); });
    await act(async () => { client.invalidate(false); });
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByRole('heading', { name: 'Ordinary sourcing inventory' })).toBeNull();
  });

  it('clears valid prior reply custody when cold-start authentication is refused', async () => {
    const { client, send } = setup();
    sessionStorage.setItem(REPLY_PENDING_KEY, JSON.stringify({ identity: JSON.stringify([id, id, id, 'admin', session.revision]),
      expiresAt: session.expiresAt, messageId: id, commandId: id, sourceRevision: 'a'.repeat(64), factRefs: [], envelopeSHA256: 'b'.repeat(64) }));
    send.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    render(<BrowserApp client={client} />);
    await waitFor(() => { expect(sessionStorage.getItem(REPLY_PENDING_KEY)).toBeNull(); });
    expect(send).toHaveBeenCalledWith('/browser/session', expect.anything());
    expect(screen.queryByRole('heading', { name: 'Replies' })).toBeNull();
  });

  it('opens reviewed replies in Email and existing preparation through Firm context without automatic generation', async () => {
    const { client, commands, send } = setup();
    render(<BrowserApp client={client} />);
    await screen.findByRole('button', { name: 'Open firm' });
    expect(screen.queryByRole('heading', { name: 'Replies' })).toBeNull();
    navigate('Email');
    await screen.findByRole('heading', { name: 'Replies' });
    expect(screen.getByRole('button', { name: 'Refresh replies' })).toBeTruthy();
    navigate('Today');
    fireEvent.click(await screen.findByRole('button', { name: 'Open firm' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Meeting preparation' }));
    await screen.findByRole('heading', { name: 'Meeting preparation' });
    expect(screen.getByRole('button', { name: 'Load existing meetings' })).toBeTruthy();
    expect(commands).toHaveLength(0);
    expect(send.mock.calls.some(([url]) => String(url).includes('/replies/composer/generate'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('shows Today, existing Firm and actual notes receipt, then clears all private views on logout', async () => {
    const { client, storage } = setup();
    render(<BrowserApp client={client} />);
    await openNotes();
    fireEvent.change(screen.getByLabelText('Your notes'), { target: { value: 'Fixture debrief' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    await screen.findByText('Saved notes revision 1.');
    expect(storage.getItem(PENDING_KEY)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByText(firm.name)).toBeNull();
    expect(screen.queryByLabelText('Your notes')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Workspace sections' })).toBeNull();
  });
  it('locks an uncertain draft, reloads without replay, explicitly retries same command identity', async () => {
    const scope = setup();
    const rendered = render(<BrowserApp client={scope.client} />);
    await openNotes();
    fireEvent.change(screen.getByLabelText('Your notes'), { target: { value: 'Retained exact debrief' } });
    scope.lose();
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    await screen.findByRole('button', { name: 'Retry save' });
    expect(scope.commands).toHaveLength(1);
    rendered.unmount();
    render(<BrowserApp client={scope.client} />);
    await openNotes();
    expect(scope.commands).toHaveLength(1);
    expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).toBe('Retained exact debrief');
    scope.recover();
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await screen.findByText('Saved notes revision 1 (existing receipt).');
    expect(scope.commands).toHaveLength(2);
    expect(scope.commands[0]).toEqual(scope.commands[1]);
  });
  it('clears mounted notes on manager invalidation without repopulation', async () => {
    const { client } = setup();
    render(<BrowserApp client={client} />);
    await openNotes();
    await act(async () => { client.invalidate(false); });
    await waitFor(() => { expect(screen.queryByLabelText('Your notes')).toBeNull(); });
    expect(screen.queryByText(firm.name)).toBeNull();
  });
});
