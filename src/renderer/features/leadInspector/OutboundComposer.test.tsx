// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { EmailDraft, OutreachApi, OutreachStatus, LocalEmailAuthorityRead } from '../../../shared/contracts/outreachContract';
import { OutboundComposer } from './OutboundComposer';

afterEach(cleanup);
const status: OutreachStatus = { model: 'ready', modelName: 'fixture-model', gmail: 'ready', accountEmail: 'founder@example.com', senderName: 'Fictional Founder', postalAddress: '123 Fictional St' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const drafts = new Map<string, EmailDraft>();
  const sent: string[] = [];
  const api: OutreachApi = {
    status: vi.fn(async () => status), configure: vi.fn(async () => status), connectGmail: vi.fn(async () => status), disconnectGmail: vi.fn(async () => status),
    openDraft: vi.fn(async ({ personId, contactMethodId }) => {
      const id = `${personId}:${contactMethodId}`;
      if (!drafts.has(id)) drafts.set(id, { id, personId, contactMethodId, salesCycleId: `cycle-${personId}`, recipient: `${personId}@example.com`, subject: 'Property context', body: `Hello ${personId}`, revision: 1, status: 'draft', generation: 'model', messageId: null, notice: null, updatedAt: '2026-09-08T12:00:00.000Z' });
      return { ...drafts.get(id)! };
    }),
    saveDraft: vi.fn(async ({ draftId, expectedRevision, subject, body }) => {
      const previous = drafts.get(draftId)!;
      if (previous.revision !== expectedRevision) throw new Error('stale');
      const saved: EmailDraft = { ...previous, subject, body, revision: expectedRevision + 1, generation: 'edited' };
      drafts.set(draftId, saved); return { ...saved };
    }),
    // Synthetic exact-current saved draft ownership only. Existing business gates remain exercised.
    inspectLocalAuthority: vi.fn(async ({ draftId, expectedRevision }): Promise<LocalEmailAuthorityRead> => {
      const current = drafts.get(draftId);
      if (!current || current.revision !== expectedRevision) throw new Error('Synthetic authority draft changed');
      return { draftId, expectedRevision, personId: current.personId, contactMethodId: current.contactMethodId,
        state: 'allowed', reason: null, checkedAt: '2026-09-10T12:00:00.000Z' };
    }),
    generateDraft: vi.fn(async ({ draftId }) => ({ ...drafts.get(draftId)! })),
    sendDraft: vi.fn(async ({ draftId, expectedRevision }) => {
      const previous = drafts.get(draftId)!;
      if (previous.revision !== expectedRevision) throw new Error('stale');
      sent.push(previous.body);
      const saved: EmailDraft = { ...previous, status: 'sent', revision: expectedRevision + 1, messageId: 'fixture-message' };
      drafts.set(draftId, saved); return { ...saved };
    }),
  };
  return { api, drafts, sent };
}
const editor = (api: OutreachApi, personId = 'avery', onClose = vi.fn()) => <OutboundComposer channel="email" recipientLabel={`${personId}@example.com`} personId={personId} contactMethodId="email" api={api} onClose={onClose} />;
const body = () => screen.getByLabelText('Message') as HTMLTextAreaElement;

it('keeps a configured unverified email editable while explicitly refusing Send', async () => {
  const { api, drafts, sent } = fixture();
  const reason = 'This email address is unverified. You can prepare a draft, but not send yet.';
  render(<OutboundComposer channel="email" recipientLabel="avery@example.com" personId="avery" contactMethodId="email"
    api={api} onClose={vi.fn()} sendBlockedReason={reason} />);
  await waitFor(() => expect(body().value).toBe('Hello avery'));
  await expect(api.inspectLocalAuthority({ draftId: 'avery:email', expectedRevision: 1 })).resolves.toMatchObject({ state: 'allowed' });
  expect(body().disabled).toBe(false);
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(reason)).toBeTruthy();
  fireEvent.change(body(), { target: { value: 'Candidate address draft, not sent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(drafts.get('avery:email')?.body).toBe('Candidate address draft, not sent'));
  expect(sent).toEqual([]);
});

it('opens the owned persisted draft without sending and shows exact account/footer preview', async () => {
  const { api, sent } = fixture(); render(editor(api));
  await waitFor(() => expect(body().value).toBe('Hello avery'));
  expect(screen.getByText('founder@example.com')).toBeTruthy();
  expect(screen.getByText('Fictional Founder\n123 Fictional St\nTo stop these emails, reply "stop".', { exact: true, normalizer: value => value })).toBeTruthy();
  expect(sent).toEqual([]);
});

it('keeps unconfigured drafts editable and persists edits on close/reopen without a send', async () => {
  const { api, drafts, sent } = fixture();
  vi.mocked(api.status).mockResolvedValue({ ...status, gmail: 'unconfigured', model: 'unconfigured', accountEmail: null });
  const close = vi.fn(); const view = render(editor(api, 'avery', close));
  await waitFor(() => expect(body().value).toBe('Hello avery'));
  expect(screen.getByRole('link', { name: /Connections/ })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(body(), { target: { value: 'My exact edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(drafts.get('avery:email')?.body).toBe('My exact edit');
  view.unmount(); render(editor(api));
  await waitFor(() => expect(body().value).toBe('My exact edit'));
  expect(sent).toEqual([]);
});

it('flushes the latest edits before one explicit send and never replays unknown', async () => {
  const { api, sent } = fixture(); const gate = deferred<EmailDraft>();
  vi.mocked(api.sendDraft).mockImplementationOnce(async request => { const saved = await api.openDraft({ personId: 'avery', contactMethodId: 'email' }); sent.push(saved.body); expect(request.expectedRevision).toBe(saved.revision); return gate.promise; });
  render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(body(), { target: { value: 'Final explicit text' } });
  const send = screen.getByRole('button', { name: 'Send' }); fireEvent.click(send); fireEvent.click(send);
  await waitFor(() => expect(sent).toEqual(['Final explicit text']));
  await act(async () => gate.resolve({ ...(await api.openDraft({ personId: 'avery', contactMethodId: 'email' })), status: 'unknown' }));
  expect(screen.getByText(/Check.*Sent/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: /Retry.*send/i })).toBeNull();
});

it('flushes old-person edits on unmount without replacing a new recipient from a late save', async () => {
  const { api, drafts } = fixture(); const gate = deferred<void>();
  vi.mocked(api.saveDraft).mockImplementationOnce(async input => { await gate.promise; const previous = drafts.get(input.draftId)!;
    const saved: EmailDraft = { ...previous, subject: input.subject, body: input.body, revision: input.expectedRevision + 1 }; drafts.set(input.draftId, saved); return saved; });
  const view = render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  fireEvent.change(body(), { target: { value: 'Avery edit' } });
  view.rerender(editor(api, 'blair'));
  await waitFor(() => expect(body().value).toBe('Hello blair'));
  fireEvent.change(body(), { target: { value: 'Blair edit' } });
  await act(async () => gate.resolve());
  expect(body().value).toBe('Blair edit');
  await waitFor(() => expect(drafts.get('avery:email')?.body).toBe('Avery edit'));
});

it('ignores an earlier open response after changing person', async () => {
  const { api } = fixture(); const gate = deferred<EmailDraft>();
  const original = await api.openDraft({ personId: 'avery', contactMethodId: 'email' });
  vi.mocked(api.openDraft).mockImplementationOnce(() => gate.promise);
  const view = render(editor(api)); view.rerender(editor(api, 'blair'));
  await waitFor(() => expect(body().value).toBe('Hello blair'));
  await act(async () => gate.resolve(original));
  expect(body().value).toBe('Hello blair');
});

it('previews the draft-bound sender and footer, not a different current configuration', async () => {
  const { api, drafts } = fixture();
  const draft = await api.openDraft({ personId: 'avery', contactMethodId: 'email' });
  drafts.set(draft.id, { ...draft, senderEmail: 'bound@example.com', footer: 'Bound Sender\n456 Bound St\nTo stop these emails, reply "stop".' });
  render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  await expect(api.inspectLocalAuthority({ draftId: 'avery:email', expectedRevision: 1 })).resolves.toMatchObject({ state: 'allowed' });
  expect(await screen.findByText('bound@example.com')).toBeTruthy();
  expect(screen.queryByText('founder@example.com')).toBeNull();
  expect(screen.getByText(/456 Bound St/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
});

it('saves newer edits typed during an earlier save before close, without replacing the editor', async () => {
  const { api, drafts } = fixture(); const gate = deferred<void>();
  const save = api.saveDraft;
  vi.mocked(api.saveDraft).mockImplementationOnce(async input => {
    await gate.promise;
    const old = drafts.get(input.draftId)!;
    const result = { ...old, subject: input.subject, body: input.body, revision: input.expectedRevision + 1 };
    drafts.set(input.draftId, result); return result;
  });
  const close = vi.fn(); render(editor(api, 'avery', close)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  fireEvent.change(body(), { target: { value: 'Earlier' } }); fireEvent.blur(body());
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  fireEvent.change(body(), { target: { value: 'Latest exact prose' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close draft' })); expect(close).not.toHaveBeenCalled();
  await act(async () => gate.resolve());
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(body().value).toBe('Latest exact prose'); expect(drafts.get('avery:email')?.body).toBe('Latest exact prose');
  expect(save).toHaveBeenCalledTimes(2);
});

it('never sends after a failed edit flush and retains recoverable exact prose', async () => {
  const { api } = fixture(); vi.mocked(api.saveDraft).mockRejectedValueOnce(new Error('secret database path'));
  render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(body(), { target: { value: 'Must not lose this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('alert'); expect(api.sendDraft).not.toHaveBeenCalled(); expect(body().value).toBe('Must not lose this');
  expect(screen.queryByText(/secret database path/)).toBeNull();
});

it('accepts a newly created same-contact draft only on explicit reopen after sending', async () => {
  const { api, drafts } = fixture(); const view = render(editor(api));
  await waitFor(() => expect(body().value).toBe('Hello avery'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Send' })); await screen.findByText(/Accepted by Gmail/);
  view.unmount();
  const previous = await api.openDraft({ personId: 'avery', contactMethodId: 'email' });
  const replacement: EmailDraft = { ...previous, id: 'new-draft', status: 'draft', revision: 1, subject: 'New email', body: 'A new reviewed conversation' };
  drafts.set(replacement.id, replacement);
  vi.mocked(api.openDraft).mockResolvedValueOnce(replacement);
  render(editor(api)); await waitFor(() => expect(body().value).toBe('A new reviewed conversation'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
  expect(api.sendDraft).toHaveBeenCalledOnce();
});
it('recovers a lost save reply on reopen without losing local prose or resending', async () => {
  const { api, drafts } = fixture();
  vi.mocked(api.saveDraft).mockImplementationOnce(async input => {
    drafts.set(input.draftId, { ...drafts.get(input.draftId)!, subject: input.subject, body: input.body, revision: input.expectedRevision + 1 });
    throw new Error('Reply lost after save');
  });
  const view = render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  fireEvent.change(body(), { target: { value: 'Persisted before lost reply' } }); fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('alert'); view.unmount();
  render(editor(api)); await waitFor(() => expect(api.openDraft).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(body().value).toBe('Persisted before lost reply'); expect(api.sendDraft).not.toHaveBeenCalled();
});
it('requires explicit conflict acknowledgement before replacing a changed saved draft', async () => {
  const { api, drafts } = fixture(); const view = render(editor(api));
  await waitFor(() => expect(body().value).toBe('Hello avery'));
  drafts.set('avery:email', { ...drafts.get('avery:email')!, body: 'Changed elsewhere', revision: 2 });
  fireEvent.change(body(), { target: { value: 'My unsaved local text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await screen.findByRole('alert'); view.unmount();
  const reopened = render(editor(api)); await waitFor(() => expect(api.openDraft).toHaveBeenCalledTimes(2));
  await expect(api.inspectLocalAuthority({ draftId: 'avery:email', expectedRevision: 2 })).resolves.toMatchObject({ state: 'allowed' });
  expect(body().value).toBe('My unsaved local text'); expect(drafts.get('avery:email')?.body).toBe('Changed elsewhere');
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.blur(body()); expect(drafts.get('avery:email')?.body).toBe('Changed elsewhere');
  fireEvent.click(screen.getByRole('button', { name: 'Save my displayed edits' }));
  await waitFor(() => expect(drafts.get('avery:email')?.body).toBe('My unsaved local text'));
  reopened.unmount(); expect(api.sendDraft).not.toHaveBeenCalled();
});
it('announces accepted email for bound workspace refresh without announcing unknown sends', async () => {
  const { api } = fixture(); const listener = vi.fn(); window.addEventListener('callie:email-sent', listener);
  try {
    render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Send' })); await screen.findByText(/Accepted by Gmail/);
    expect(listener).toHaveBeenCalledOnce(); expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ personId: 'avery', salesCycleId: 'cycle-avery' });
  } finally { window.removeEventListener('callie:email-sent', listener); }
});

function expectSingleCall(fn:unknown,...args:unknown[]) { expect(fn).toHaveBeenCalledTimes(1);expect(fn).toHaveBeenCalledWith(...args); }
// Task7 source-only additions. Real component and retained WeakMap session, no surrogate owner.
const sendButton=()=>screen.getByRole('button',{name:'Send'}) as HTMLButtonElement;
const saveButton=()=>screen.getByRole('button',{name:'Save draft'}) as HTMLButtonElement;
function allowedRead(draft:EmailDraft):LocalEmailAuthorityRead {
  return {draftId:draft.id,expectedRevision:draft.revision,personId:draft.personId,contactMethodId:draft.contactMethodId,
    state:'allowed',reason:null,checkedAt:'2026-09-10T12:00:00.000Z'};
}
function ownedAuthorityRead() {
  let resolve!:(value:LocalEmailAuthorityRead)=>void;let reject!:(error:Error)=>void;
  const promise=new Promise<LocalEmailAuthorityRead>((yes,no)=>{resolve=yes;reject=no;});
  // This observes only this fixture promise, not arbitrary service or network work.
  const settled=promise.then(():undefined=>undefined,():undefined=>undefined);
  return {promise,resolve,reject,settled};
}
it('Task7 pending ownership alone holds ready Send, exact allowed enables it, Save stays independent',async()=>{
  const {api,drafts}=fixture();const read=ownedAuthorityRead();
  vi.mocked(api.inspectLocalAuthority).mockImplementationOnce(()=>read.promise);
  const view=render(editor(api));
  try {
    await waitFor(()=>expectSingleCall(api.inspectLocalAuthority,{draftId:'avery:email',expectedRevision:1}));
    expect(body().value).toBe('Hello avery');expect(sendButton().disabled).toBe(true);expect(saveButton().disabled).toBe(false);
    await act(async()=>{read.resolve(allowedRead(drafts.get('avery:email')!));await read.settled;});
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    expect(api.generateDraft).not.toHaveBeenCalled();expect(api.sendDraft).not.toHaveBeenCalled();expect(api.configure).not.toHaveBeenCalled();
  } finally {read.reject(Error('fixture cleanup'));await read.settled;view.unmount();}
},10000);

it.each(['held','rejected','draft','revision','person','contact'] as const)('Task7 ready Send refuses %s authority and recovers on focus',async mode=>{
  const {api,drafts}=fixture();const view=render(editor(api));
  try {
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    const current=allowedRead(drafts.get('avery:email')!);
    if(mode==='rejected') vi.mocked(api.inspectLocalAuthority).mockRejectedValueOnce(Error('SECRET authority exception'));
    else vi.mocked(api.inspectLocalAuthority).mockResolvedValueOnce(mode==='held'?{...current,state:'held',reason:'email_authority_unavailable'}:
      {...current,...(mode==='draft'?{draftId:'old-draft'}:mode==='revision'?{expectedRevision:2}:mode==='person'?{personId:'blair'}:{contactMethodId:'other-email'})});
    const before=vi.mocked(api.inspectLocalAuthority).mock.calls.length;
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    await waitFor(()=>expect(api.inspectLocalAuthority).toHaveBeenCalledTimes(before+1));
    await waitFor(()=>expect(sendButton().disabled).toBe(true));
    expect(saveButton().disabled).toBe(false);expect(body().disabled).toBe(false);expect(screen.queryByText(/SECRET/)).toBeNull();
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    await waitFor(()=>expect(api.inspectLocalAuthority).toHaveBeenCalledTimes(before+2));
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    expect(api.sendDraft).not.toHaveBeenCalled();
  } finally {view.unmount();}
},10000);

it.each(['This email address is unverified.','This contact has conflicting identity.'])('Task7 allowed ownership retains caller hold: %s',async reason=>{
  const {api}=fixture();const view=render(editor(api));
  try {
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    view.rerender(<OutboundComposer channel="email" recipientLabel="avery@example.com" personId="avery" contactMethodId="email" api={api} onClose={vi.fn()} sendBlockedReason={reason}/>);
    expect(sendButton().disabled).toBe(true);expect(saveButton().disabled).toBe(false);expect(screen.getByText(reason)).toBeTruthy();
    expect(api.inspectLocalAuthority).toHaveBeenCalled();expect(api.sendDraft).not.toHaveBeenCalled();
  } finally {view.unmount();}
},10000);

it.each(['person','contact','api'] as const)('Task7 late old authority cannot enable replacement %s',async change=>{
  const first=fixture();const second=change==='api'?fixture():first;
  const old=ownedAuthorityRead();const current=ownedAuthorityRead();
  vi.mocked(first.api.inspectLocalAuthority).mockImplementationOnce(()=>old.promise);
  if(change==='api') vi.mocked(second.api.inspectLocalAuthority).mockImplementationOnce(()=>current.promise);
  else vi.mocked(first.api.inspectLocalAuthority).mockImplementationOnce(()=>current.promise);
  const view=render(editor(first.api));
  try {
    await waitFor(()=>expect(first.api.inspectLocalAuthority).toHaveBeenCalledTimes(1));
    const oldDraft=first.drafts.get('avery:email')!;
    const person=change==='person'?'blair':'avery';const contact=change==='contact'?'alternate-email':'email';
    view.rerender(<OutboundComposer channel="email" recipientLabel={`${person}@example.com`} personId={person} contactMethodId={contact} api={second.api} onClose={vi.fn()}/>);
    await waitFor(()=>expect(second.api.inspectLocalAuthority).toHaveBeenCalledTimes(change==='api'?1:2));
    expect(sendButton().disabled).toBe(true);
    await act(async()=>{old.resolve(allowedRead(oldDraft));await old.settled;});
    expect(sendButton().disabled).toBe(true);
    await act(async()=>{current.resolve(allowedRead(second.drafts.get(`${person}:${contact}`)!));await current.settled;});
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    expect(first.api.sendDraft).not.toHaveBeenCalled();expect(second.api.sendDraft).not.toHaveBeenCalled();
  } finally {old.reject(Error('fixture cleanup'));current.reject(Error('fixture cleanup'));await Promise.all([old.settled,current.settled]);view.unmount();}
},10000);

it('Task7 same-contact replacement draft rejects old ID success after remount',async()=>{
  const {api,drafts}=fixture();const old=ownedAuthorityRead();const current=ownedAuthorityRead();
  vi.mocked(api.inspectLocalAuthority).mockImplementationOnce(()=>old.promise).mockImplementationOnce(()=>current.promise);
  let view=render(editor(api));
  try {
    await waitFor(()=>expect(api.inspectLocalAuthority).toHaveBeenCalledTimes(1));
    const previous=drafts.get('avery:email')!;view.unmount();
    const replacement={...previous,id:'fictional-new-draft',body:'New exact manually retained text',generation:'edited' as const};
    drafts.set('avery:email',replacement);drafts.set(replacement.id,replacement);
    view=render(editor(api));
    await waitFor(()=>expect(body().value).toBe(replacement.body));
    await waitFor(()=>expect(api.inspectLocalAuthority).toHaveBeenLastCalledWith({draftId:replacement.id,expectedRevision:1}));
    await act(async()=>{current.reject(Error('newer read failed'));await current.settled;});
    await act(async()=>{old.resolve(allowedRead(previous));await old.settled;});
    expect(sendButton().disabled).toBe(true);expect(saveButton().disabled).toBe(false);
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    await waitFor(()=>expect(sendButton().disabled).toBe(false));expect(body().value).toBe(replacement.body);
    expect(api.generateDraft).not.toHaveBeenCalled();expect(api.sendDraft).not.toHaveBeenCalled();
  } finally {old.reject(Error('fixture cleanup'));current.reject(Error('fixture cleanup'));await Promise.all([old.settled,current.settled]);view.unmount();}
},10000);

it('Task7 saved revision starts exact new read and older success cannot replace new failure',async()=>{
  const {api,drafts}=fixture();const old=ownedAuthorityRead();const current=ownedAuthorityRead();
  vi.mocked(api.inspectLocalAuthority).mockImplementationOnce(()=>old.promise).mockImplementationOnce(()=>current.promise);
  const view=render(editor(api));
  try {
    await waitFor(()=>expect(api.inspectLocalAuthority).toHaveBeenCalledTimes(1));
    const previous={...drafts.get('avery:email')!};
    fireEvent.change(body(),{target:{value:'New revision exact text'}});fireEvent.click(saveButton());
    await waitFor(()=>expect(api.inspectLocalAuthority).toHaveBeenLastCalledWith({draftId:previous.id,expectedRevision:2}));
    expect(sendButton().disabled).toBe(true);
    await act(async()=>{current.reject(Error('new revision refused'));await current.settled;});
    await act(async()=>{old.resolve(allowedRead(previous));await old.settled;});
    expect(sendButton().disabled).toBe(true);expect(body().value).toBe('New revision exact text');expect(saveButton().disabled).toBe(false);
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    expect(api.inspectLocalAuthority).toHaveBeenLastCalledWith({draftId:previous.id,expectedRevision:2});
    expect(api.openDraft).toHaveBeenCalledOnce();expect(api.generateDraft).not.toHaveBeenCalled();
  } finally {old.reject(Error('fixture cleanup'));current.reject(Error('fixture cleanup'));await Promise.all([old.settled,current.settled]);view.unmount();}
},10000);

it.each(['newer-failure','newer-success'] as const)('Task7 focus refresh generation retains %s over older same-tuple completion',async order=>{
  const {api,drafts}=fixture();const older=ownedAuthorityRead();const newer=ownedAuthorityRead();const view=render(editor(api));
  try {
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    fireEvent.change(body(),{target:{value:'Retained edited draft on focus'}});fireEvent.click(saveButton());
    await waitFor(()=>expect(drafts.get('avery:email')?.revision).toBe(2));
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    const read=allowedRead(drafts.get('avery:email')!);const count=vi.mocked(api.inspectLocalAuthority).mock.calls.length;
    const setupCount=vi.mocked(api.status).mock.calls.length;
    vi.mocked(api.inspectLocalAuthority).mockImplementationOnce(()=>older.promise).mockImplementationOnce(()=>newer.promise);
    act(()=>{window.dispatchEvent(new Event('focus'));});
    expect(sendButton().disabled).toBe(true);
    await waitFor(()=>expect(api.inspectLocalAuthority).toHaveBeenCalledTimes(count+1));
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    await waitFor(()=>expect(api.inspectLocalAuthority).toHaveBeenCalledTimes(count+2));
    await act(async()=>{if(order==='newer-failure') newer.reject(Error('new observation failed'));else newer.resolve(read);await newer.settled;});
    await waitFor(()=>expect(sendButton().disabled).toBe(order==='newer-failure'));
    await act(async()=>{if(order==='newer-failure') older.resolve(read);else older.reject(Error('old observation failed'));await older.settled;});
    expect(sendButton().disabled).toBe(order==='newer-failure');expect(saveButton().disabled).toBe(false);
    expect(api.status).toHaveBeenCalledTimes(setupCount+2);expect(api.openDraft).toHaveBeenCalledOnce();
    expect(api.generateDraft).not.toHaveBeenCalled();expect(body().value).toBe('Retained edited draft on focus');
    expect(api.sendDraft).not.toHaveBeenCalled();expect(api.configure).not.toHaveBeenCalled();
  } finally {older.reject(Error('fixture cleanup'));newer.reject(Error('fixture cleanup'));await Promise.all([older.settled,newer.settled]);view.unmount();}
},10000);

it('Task7 refusing ownership and unconfigured providers preserve exact manual Save and remount',async()=>{
  const {api,drafts}=fixture();vi.mocked(api.status).mockResolvedValue({...status,model:'unconfigured',gmail:'unconfigured',accountEmail:null});
  vi.mocked(api.inspectLocalAuthority).mockImplementation(async input=>({...allowedRead(drafts.get(input.draftId)!),state:'held',reason:'email_authority_unavailable'}));
  let view=render(editor(api));
  try {
    await waitFor(()=>expect(body().value).toBe('Hello avery'));
    await waitFor(()=>expect(api.inspectLocalAuthority).toHaveBeenCalled());
    expect(sendButton().disabled).toBe(true);expect(saveButton().disabled).toBe(false);
    const exact='Manually reviewed line one\nLine two, unchanged.';
    fireEvent.change(body(),{target:{value:exact}});fireEvent.click(saveButton());
    await waitFor(()=>expect(drafts.get('avery:email')?.body).toBe(exact));
    const before=vi.mocked(api.inspectLocalAuthority).mock.calls.length;const setupBefore=vi.mocked(api.status).mock.calls.length;
    view.unmount();view=render(editor(api));
    await waitFor(()=>expect(body().value).toBe(exact));
    await waitFor(()=>expect(vi.mocked(api.inspectLocalAuthority).mock.calls.length).toBeGreaterThan(before));
    expect(vi.mocked(api.status).mock.calls.length).toBeGreaterThan(setupBefore);
    expect(sendButton().disabled).toBe(true);expect(saveButton().disabled).toBe(false);
    expect(api.generateDraft).not.toHaveBeenCalled();expect(api.sendDraft).not.toHaveBeenCalled();expect(api.connectGmail).not.toHaveBeenCalled();
  } finally {view.unmount();}
},10000);

it('Task7 actual hash settings return refreshes retained composer setup and authority without reopen',async()=>{
  const {api,drafts}=fixture();const originalUrl=window.location.href;
  window.history.replaceState(null,'','#/today');const view=render(editor(api));
  const hashSeen=vi.fn();window.addEventListener('hashchange',hashSeen);
  try {
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    fireEvent.change(body(),{target:{value:'Exact edited text across settings return'}});fireEvent.click(saveButton());
    await waitFor(()=>expect(drafts.get('avery:email')?.revision).toBe(2));
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    // Actual browser hash assignments emit hashchange, as useHashRoute consumes.
    window.location.hash='#/settings';
    await waitFor(()=>expect(hashSeen).toHaveBeenCalled());
    const reads=vi.mocked(api.inspectLocalAuthority).mock.calls.length;const setups=vi.mocked(api.status).mock.calls.length;
    vi.mocked(api.status).mockResolvedValue({...status,gmail:'unconfigured'});
    window.location.hash='#/today';
    await waitFor(()=>expect(vi.mocked(api.inspectLocalAuthority).mock.calls.length).toBeGreaterThan(reads));
    await waitFor(()=>expect(vi.mocked(api.status).mock.calls.length).toBeGreaterThan(setups));
    await waitFor(()=>expect(sendButton().disabled).toBe(true));expect(saveButton().disabled).toBe(false);
    expect(body().value).toBe('Exact edited text across settings return');
    expect(api.inspectLocalAuthority).toHaveBeenLastCalledWith({draftId:'avery:email',expectedRevision:2});
    expect(api.openDraft).toHaveBeenCalledOnce();expect(api.generateDraft).not.toHaveBeenCalled();expect(api.sendDraft).not.toHaveBeenCalled();
  } finally {window.removeEventListener('hashchange',hashSeen);view.unmount();window.history.replaceState(null,'',originalUrl);}
},10000);

it.each(['focus','hashchange'] as const)('Task7 %s immediately invalidates allowance without flushing dirty edits',async event=>{
  const {api,drafts}=fixture();const pending=ownedAuthorityRead();const url=window.location.href;
  window.history.replaceState(null,'','#/settings');const view=render(editor(api));
  let sawHash=false;const onHash=()=>{sawHash=true;};window.addEventListener('hashchange',onHash);
  try {
    await waitFor(()=>expect(sendButton().disabled).toBe(false));
    fireEvent.change(body(),{target:{value:'Unsaved exact text must not flush on observation'}});
    const calls=vi.mocked(api.inspectLocalAuthority).mock.calls.length;
    vi.mocked(api.inspectLocalAuthority).mockImplementationOnce(()=>pending.promise);
    if(event==='focus') act(()=>{window.dispatchEvent(new Event('focus'));});
    else {window.location.hash='#/today';await waitFor(()=>expect(sawHash).toBe(true));}
    expect(sendButton().disabled).toBe(true);
    await waitFor(()=>expect(api.inspectLocalAuthority).toHaveBeenCalledTimes(calls+1));
    expect(api.inspectLocalAuthority).toHaveBeenLastCalledWith({draftId:'avery:email',expectedRevision:1});
    expect(api.saveDraft).not.toHaveBeenCalled();expect(api.openDraft).toHaveBeenCalledOnce();expect(api.generateDraft).not.toHaveBeenCalled();
    expect(drafts.get('avery:email')?.body).toBe('Hello avery');expect(body().value).toBe('Unsaved exact text must not flush on observation');
    expect(saveButton().disabled).toBe(false);
    await act(async()=>{pending.resolve(allowedRead(drafts.get('avery:email')!));await pending.settled;});
    await waitFor(()=>expect(sendButton().disabled).toBe(false));expect(api.sendDraft).not.toHaveBeenCalled();
    // Explicit Save owns the flush, not the refresh or final fixture unmount.
    fireEvent.click(saveButton());await waitFor(()=>expect(drafts.get('avery:email')?.revision).toBe(2));
  } finally {pending.reject(Error('fixture cleanup'));await pending.settled;window.removeEventListener('hashchange',onHash);view.unmount();window.history.replaceState(null,'',url);}
},10000);

// Parent Task7 review correction: setup observation has its own request lifetime.
function ownedSetupRead() {
  let resolve!: (value: OutreachStatus) => void; let reject!: (error: Error) => void;
  const promise = new Promise<OutreachStatus>((yes, no) => { resolve = yes; reject = no; });
  const settled = promise.then((): undefined => undefined, (): undefined => undefined);
  return { promise, resolve, reject, settled };
}
it.each(['focus', 'hashchange'] as const)('Task7 %s current setup pending/rejection holds independently of allowed ownership', async event => {
  const { api, drafts } = fixture(); const pending = ownedSetupRead(); const url = window.location.href;
  window.history.replaceState(null, '', '#/settings'); const view = render(editor(api));
  let sawHash = false; const onHash = () => { sawHash = true; }; window.addEventListener('hashchange', onHash);
  try {
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    const textarea = body(); fireEvent.change(textarea, { target: { value: 'Unsaved prose during setup refresh' } });
    const calls = vi.mocked(api.status).mock.calls.length;
    vi.mocked(api.status).mockImplementationOnce(() => pending.promise);
    if (event === 'focus') act(() => { window.dispatchEvent(new Event('focus')); });
    else { window.location.hash = '#/today'; await waitFor(() => expect(sawHash).toBe(true)); }
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(calls + 1));
    expect(sendButton().disabled).toBe(true); expect(saveButton().disabled).toBe(false);
    await act(async () => { pending.reject(Error('SECRET current setup unavailable')); await pending.settled; });
    expect(sendButton().disabled).toBe(true); expect(screen.queryByText(/SECRET/)).toBeNull();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(calls + 2));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(body()).toBe(textarea); expect(body().value).toBe('Unsaved prose during setup refresh');
    expect(drafts.get('avery:email')?.body).toBe('Hello avery');
    expect(api.openDraft).toHaveBeenCalledOnce(); expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.generateDraft).not.toHaveBeenCalled(); expect(api.sendDraft).not.toHaveBeenCalled();
    fireEvent.click(saveButton()); await waitFor(() => expect(drafts.get('avery:email')?.revision).toBe(2));
  } finally { pending.reject(Error('fixture cleanup')); await pending.settled; window.removeEventListener('hashchange', onHash); view.unmount(); window.history.replaceState(null, '', url); }
}, 10000);
it.each(['newer-rejected', 'newer-unconfigured', 'newer-ready'] as const)('Task7 setup generation retains %s over older opposite completion', async order => {
  const { api } = fixture(); const older = ownedSetupRead(); const newer = ownedSetupRead(); const view = render(editor(api));
  try {
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    const count = vi.mocked(api.status).mock.calls.length;
    vi.mocked(api.status).mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(count + 1)); expect(sendButton().disabled).toBe(true);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(count + 2));
    await act(async () => {
      if (order === 'newer-rejected') newer.reject(Error('new setup unavailable'));
      else newer.resolve(order === 'newer-unconfigured' ? { ...status, gmail: 'unconfigured' } : status);
      await newer.settled;
    });
    await waitFor(() => expect(sendButton().disabled).toBe(order !== 'newer-ready'));
    await act(async () => {
      if (order === 'newer-ready') older.reject(Error('old setup unavailable')); else older.resolve(status);
      await older.settled;
    });
    expect(sendButton().disabled).toBe(order !== 'newer-ready'); expect(saveButton().disabled).toBe(false);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(count + 3));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(api.openDraft).toHaveBeenCalledOnce(); expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.generateDraft).not.toHaveBeenCalled(); expect(api.sendDraft).not.toHaveBeenCalled();
  } finally { older.reject(Error('fixture cleanup')); newer.reject(Error('fixture cleanup')); await Promise.all([older.settled, newer.settled]); view.unmount(); }
}, 10000);
it('Task7 old API setup completion cannot enable the replacement API draft', async () => {
  const first = fixture(); const second = fixture(); const old = ownedSetupRead();
  vi.mocked(first.api.status).mockImplementationOnce(() => old.promise);
  vi.mocked(second.api.status).mockResolvedValue({ ...status, gmail: 'unconfigured' });
  const view = render(editor(first.api));
  try {
    await waitFor(() => expect(first.api.status).toHaveBeenCalledOnce());
    await waitFor(() => expect(body().value).toBe('Hello avery'));
    view.rerender(editor(second.api));
    await waitFor(() => expect(second.api.status).toHaveBeenCalledOnce());
    await waitFor(() => expect(second.api.inspectLocalAuthority).toHaveBeenCalled());
    expect(sendButton().disabled).toBe(true);
    await act(async () => { old.resolve(status); await old.settled; });
    expect(sendButton().disabled).toBe(true); expect(saveButton().disabled).toBe(false);
    vi.mocked(second.api.status).mockResolvedValue(status);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(second.api.status).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(first.api.sendDraft).not.toHaveBeenCalled(); expect(second.api.sendDraft).not.toHaveBeenCalled();
    expect(second.api.openDraft).toHaveBeenCalledOnce(); expect(second.api.generateDraft).not.toHaveBeenCalled();
  } finally { old.reject(Error('fixture cleanup')); await old.settled; view.unmount(); }
}, 10000);
