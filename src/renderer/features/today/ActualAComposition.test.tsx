// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeDesk, NativeDeskRoute } from './NativeDeskRoute';
import { dailyFixture, nativeDeskFixture, linkedInFixture, requestedDraft, fixtureNow, configuredFixtureStatus, localSnapshot, commitments } from './nativeDesk.fixture';
import { requestedDisplayBindingSchema, manualDisplayBindingSchema } from '../../../shared/contracts/dailyAnswerPresentationContract';
import type { DailyAnswer } from '../../../shared/contracts/dailyContract';
import { DailyAnswerDetail, DailyAnswers } from './DailyAnswers';
import { createHash } from 'node:crypto';
import { RetainedWork } from './RetainedWork';
import type { LocalCommitmentsSnapshot } from '../../../shared/contracts/localWorkspaceContract';
afterEach(cleanup);

it('presents the retained recipient before the editor and keeps company diagnostics secondary', async () => {
  const f = nativeDeskFixture();
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Email · Account A' }));
  const editor = screen.getByRole('textbox', { name: 'Email body' });
  const identity = screen.getByRole('heading', { name: 'a@fixture.invalid' });
  expect(identity.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText('Original call context unavailable').compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText(/Hypothesis: Unconfirmed workflow/).closest('details')?.open).toBe(false);
  const permission = screen.getByRole('checkbox');
  expect(permission.closest('details')).toBeNull();
  expect(screen.getByText(/Confirm the request and choose a future expiry/)).toBeTruthy();
  const checks = screen.getByText('Approval checks').closest('details');
  expect(checks?.open).toBe(true);
  expect(within(checks!).getByRole('button', {name:'Owner preflight'})).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approve email' }).closest('footer')).toBe(screen.getByRole('button', { name: 'Save edits' }).closest('footer'));
});

it('uses one intentional unpaired surface and unavailable counts instead of zero-work claims', async () => {
  const f = nativeDeskFixture(dailyFixture({ workspaceId: null, accounts: [], answers: [], calls: { accountIds: [], workloadConflict: false } }));
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  const root = await screen.findByTestId('native-desk');
  const queue = within(root).getByRole('navigation', { name: 'Today queue' });
  expect(queue.querySelectorAll('.native-desk__count')).toHaveLength(3);
  for (const count of queue.querySelectorAll('.native-desk__count')) expect(count.textContent).toBe('Unavailable');
  expect(within(queue).queryByText(/No retained work|Account .* unavailable|No approvals|No stored meetings/)).toBeNull();
  const surface = root.querySelector('.native-desk__welcome')!;
  expect(surface.textContent).toContain('Local work remains available');
  expect(within(surface as HTMLElement).getByRole('link', { name: 'Review Settings' }).getAttribute('href')).toBe('#/settings');
  expect(within(surface as HTMLElement).queryByRole('textbox')).toBeNull();
});

function namedRequested(): Extract<DailyAnswer, {kind: 'requested_followup'}> {
  const draft = requestedDraft();
  draft.recipientBinding = {kind: 'account_route', routeId: 'email-a', routeVersion: 1, email: draft.recipient};
  return {kind: 'requested_followup', accountId: 'a', draft, approval: null, capability: 'held', reason: 'requires_owner_preflight', presentation: {
    kind: 'requested_followup', asOf: fixtureNow, binding: requestedDisplayBindingSchema.parse(Object.fromEntries(Object.entries({...draft, workspaceId: 'ws'}).filter(([key]) => !['revision','subject','body','evidenceIds','generation','updatedAt'].includes(key)))), issues: [],
    contact: {basis: 'recipient_route', personId: 'person-a', personVersion: 1, displayName: 'Nora Fixture', route: {id: 'email-a', accountId: 'a', personId: 'person-a', channel: 'email', value: draft.recipient, purpose: 'business', verification: 'confirmed', evidenceIds: ['evidence'], version: 1}, role: {linkId: 'role', value: 'Operations director', validFrom: '2026-01-01T00:00:00.000Z', validTo: null, evidenceIds: ['role-evidence']}},
    callContext: {basis: 'human_reported_call_outcome', originalCall: draft.originalCall, outcome: 'connected', observedAt: '2026-09-08T10:00:00.000Z', noteText: 'Asked for the maintenance outline.', linkedContact: null}
  }};
}
it('shows exact named person/company/role and human-reported context in saved row and editor', async () => {
  const item = namedRequested();
  const f = nativeDeskFixture(dailyFixture({answers: [item]}));
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  const row = await screen.findByRole('button', {name: /Email · Account A/});
  expect(row.getAttribute('aria-description')).toContain('Nora Fixture');
  expect(within(row).getByText('Nora Fixture')).toBeTruthy();
  expect(within(row).getByText('Account A')).toBeTruthy();
  fireEvent.click(row);
  const heading = screen.getByRole('heading', {name: 'Nora Fixture'});
  expect(heading.closest('header')?.textContent).toContain('Operations director');
  expect(heading.closest('header')?.textContent).toContain('NF');
  const context = screen.getByRole('region', {name: 'Original call context'});
  expect(context.textContent).toContain('Human-reported call note');
  expect(context.textContent).toContain('Asked for the maintenance outline.');
  expect(context.querySelector('time')?.dateTime).toBe('2026-09-08T10:00:00.000Z');
  expect(context.compareDocumentPosition(screen.getByRole('textbox', {name: 'Email body'})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('updates optional labels without remounting the controlled input or accepting mismatched context', async () => {
  const item = namedRequested();
  const f = nativeDeskFixture(dailyFixture({answers: [item]}));
  const props = {workspaceId: 'ws', api: f.api.delegation, linkedin: f.api.linkedin, company: 'Account A'};
  const view = render(<DailyAnswerDetail {...props} item={item} />);
  const body = screen.getByRole('textbox', {name: 'Email body'}) as HTMLTextAreaElement;
  body.focus(); body.setSelectionRange(2, 5);
  const next = structuredClone(item);
  next.presentation!.contact!.displayName = 'Nora Updated';
  view.rerender(<DailyAnswerDetail {...props} item={next} />);
  expect(screen.getByRole('heading', {name: 'Nora Updated'})).toBeTruthy();
  expect(screen.getByRole('textbox', {name: 'Email body'})).toBe(body);
  expect([body.selectionStart, body.selectionEnd]).toEqual([2,5]);
  const wrong = structuredClone(next);
  wrong.presentation!.binding.recipient = 'foreign@fixture.invalid';
  view.rerender(<DailyAnswerDetail {...props} item={wrong} actionHold="Read unavailable" />);
  expect(screen.queryByRole('heading', {name: 'Nora Updated'})).toBeNull();
  expect(screen.getByRole('heading', {name: 'a@fixture.invalid'})).toBeTruthy();
  expect(screen.getByText('Original call context unavailable')).toBeTruthy();
  expect(screen.getByRole('textbox', {name: 'Email body'})).toBe(body);
});
it('matches manual labels to the retained target and preserves manual input across incoming target conflict', async () => {
  const item = linkedInFixture();
  item.draft.personId = 'manual-person';
  item.draft.targetHash = createHash('sha256').update('https://www.linkedin.com/in/manual-fixture').digest('hex');
  item.presentation = {kind: 'manual_linkedin', asOf: fixtureNow, binding: manualDisplayBindingSchema.parse(Object.fromEntries(Object.entries(item.draft).filter(([key]) => !['revision','body','contentHash','state','updatedAt'].includes(key)))), issues: [], contact: {basis: 'manual_route', personId: 'manual-person', personVersion: 1, displayName: 'Marcus Fixture', route: {id: item.draft.routeId, accountId: 'a', personId: 'manual-person', channel: 'linkedin', value: 'https://www.linkedin.com/in/manual-fixture', purpose: 'business', verification: 'confirmed', evidenceIds: ['evidence'], version: 1}, role: null}};
  const f = nativeDeskFixture(dailyFixture({answers: [item]}));
  const props = {workspaceId: 'ws', api: f.api.delegation, linkedin: f.api.linkedin, company: 'Account A'};
  const view = render(<DailyAnswerDetail {...props} item={item} />);
  const note = screen.getByRole('textbox', {name: 'LinkedIn note'});
  expect(screen.getByRole('heading', {name: 'Marcus Fixture'})).toBeTruthy();
  fireEvent.change(note, {target:{value:'Retained local note'}});
  const next = structuredClone(item);
  next.draft.routeVersion = 2;
  next.presentation!.binding.routeVersion = 2;
  next.presentation!.contact!.route.version = 2;
  next.presentation!.contact!.displayName = 'Other Contact';
  view.rerender(<DailyAnswerDetail {...props} item={next} />);
  await waitFor(() => expect(screen.getByText('Saved LinkedIn version needs review')).toBeTruthy());
  expect(screen.queryByRole('heading', {name: 'Other Contact'})).toBeNull();
  expect(screen.getByRole('heading', {name: 'Account A'})).toBeTruthy();
  expect(screen.getByRole('textbox', {name: 'LinkedIn note'})).toBe(note);
  expect((note as HTMLTextAreaElement).value).toBe('Retained local note');
});

it('shows actual retained company and due time beside the original action', () => {
  const value: LocalCommitmentsSnapshot = {scope:'local_database', generatedAt: fixtureNow, revision:1, reviewErrorCount:0, items:[{kind:'callback',item:{id:'cycle',salesCycleId:'cycle',personId:'person',personName:'Retained Person',contextLabel:'Stored Company',stage:'interviewed',priorityContext:null,action:{id:'action',type:'follow_up',channel:'email',label:'Review requested details',dueAt:'2026-09-10T09:00:00.000Z'},lane:'later',reason:'Recorded callback',activeTriggers:[],verifyFirst:false,pinned:false,consentRequirement:null,cloudScores:null}}]};
  render(<RetainedWork read={{value,pending:false,error:false}} selected={null} onSelect={vi.fn()} />);
  const row = screen.getByRole('button', {name:/Retained callback/});
  expect(within(row).getByText('Stored Company')).toBeTruthy();
  expect(row.querySelector('time')?.dateTime).toBe('2026-09-10T09:00:00.000Z');
  expect(within(row).getByText('Review requested details')).toBeTruthy();
});
it('distinguishes pending approval from applied approval in the identity tag', () => {
  const item = namedRequested();
  item.approval = {state:'pending_preflight',receipt:{commandId:'approval',status:'pending',authorityGeneration:1,aggregateVersion:1,reason:null},intentCommandId:null,reason:null};
  const f = nativeDeskFixture(dailyFixture({answers:[item]}));
  render(<DailyAnswerDetail item={item} workspaceId="ws" api={f.api.delegation} linkedin={f.api.linkedin} company="Account A" />);
  expect(screen.getByRole('heading',{name:'Nora Fixture'}).closest('header')?.textContent).toContain('Approval pending');
});
it('keeps partial source warnings even when worker scope is unavailable', async () => {
  const f = nativeDeskFixture(dailyFixture({workspaceId:null,accounts:[],answers:[],calls:{accountIds:[],workloadConflict:false},freshness:{kind:'incomplete',generatedAt:fixtureNow,remote:'unknown'},issues:[{code:'scope_unknown',count:1},{code:'invalid_local_record',count:1}]}));
  render(<NativeDeskRoute api={f.api} onOpenLead={vi.fn()} />);
  await screen.findByTestId('native-desk');
  expect(screen.getByText(/The daily snapshot is incomplete/)).toBeTruthy();
});

it('keeps routine owner preflight discoverable without preceding the primary save actions', () => {
  const item = namedRequested();
  const f = nativeDeskFixture(dailyFixture({answers:[item]}));
  render(<DailyAnswerDetail item={item} workspaceId="ws" api={f.api.delegation} linkedin={f.api.linkedin} company="Account A" />);
  const checks = screen.getByText('Approval checks').closest('details')!;
  expect(checks.open).toBe(false);
  fireEvent.click(screen.getByText('Approval checks'));
  expect(within(checks).getByRole('button', {name:'Owner preflight'})).toBeTruthy();
  expect(screen.getByRole('checkbox').closest('details')).toBeNull();
  expect(screen.getByLabelText('Approval expiry').closest('details')).toBeNull();
});

it.each([
  ['missing', '0 + unknown'], ['missing_allocated', '1 + unknown'], ['pending', '0 + unknown'], ['failed', '0 + unknown'],
  ['partial', '0+ · partial'], ['stale', '0 · last known'], ['refreshing', '0 · checking'], ['known', '0'],
] as const)('does not count %s retained-source contribution as a known scoped total', (mode, count) => {
  const snapshot = dailyFixture({calls:{accountIds:mode === 'missing_allocated' ? ['a'] : [],workloadConflict:false}});
  const f = nativeDeskFixture(snapshot);
  const retained = {value: ['partial','stale','refreshing','known'].includes(mode) ? commitments({reviewErrorCount:mode === 'partial' ? 1 : 0}) : null, pending:mode === 'pending' || mode === 'refreshing', error:mode === 'failed' || mode === 'stale'};
  render(<NativeDesk snapshot={snapshot} api={f.api} config={configuredFixtureStatus()} onRefresh={vi.fn()} onOpenLead={vi.fn()} localRead={mode === 'missing' ? undefined : {overview:{value:localSnapshot(),pending:false,error:false},retained}} />);
  expect(screen.getByRole('heading',{name:/^Calls/}).querySelector('.native-desk__count')?.textContent).toBe(count);
});
it.each(['owner_supplied','missing_contact','mismatch'] as const)('exposes exact %s recipient fallback in accessible row descriptions', mode => {
  const first = namedRequested();
  if(mode === 'owner_supplied') { first.draft = requestedDraft(); delete first.presentation; }
  if(mode === 'missing_contact') first.presentation!.contact = null;
  if(mode === 'mismatch') first.presentation!.binding.recipient = 'wrong@fixture.invalid';
  const second = structuredClone(first);
  second.draft.id = 'second-draft'; second.draft.recipient = 'second@fixture.invalid';
  second.draft.recipientBinding = {kind:'owner_supplied',email:second.draft.recipient,originalCall:second.draft.originalCall}; delete second.presentation;
  render(<DailyAnswers items={[first,second]} workspaceId="ws" selected={null} name={() => 'Same Company'} onSelect={vi.fn()} />);
  const rows = screen.getAllByRole('button',{name:'Email · Same Company'});
  expect(rows.map(row => row.getAttribute('aria-description'))).toEqual(['a@fixture.invalid','second@fixture.invalid']);
  expect(within(rows[0]).getByText('a@fixture.invalid')).toBeTruthy();
  expect(within(rows[1]).getByText('second@fixture.invalid')).toBeTruthy();
});

it('reveals a focused editor only within its message scroll owner without changing selection or text', () => {
  const item=namedRequested(), f=nativeDeskFixture(dailyFixture({answers:[item]}));
  render(<DailyAnswerDetail item={item} workspaceId="ws" api={f.api.delegation} linkedin={f.api.linkedin} company="Account A" />);
  const body=screen.getByRole('textbox',{name:'Email body'}) as HTMLTextAreaElement;
  const area=body.closest('.native-desk__message-area') as HTMLElement;
  vi.spyOn(area,'getBoundingClientRect').mockReturnValue({top:100,bottom:300,height:200,left:0,right:400,width:400,x:0,y:100,toJSON:()=>({})});
  vi.spyOn(body,'getBoundingClientRect').mockReturnValue({top:310,bottom:400,height:90,left:0,right:400,width:400,x:0,y:310,toJSON:()=>({})});
  body.setSelectionRange(2,5); fireEvent.focus(body);
  expect(area.scrollTop).toBe(100);
  vi.mocked(body.getBoundingClientRect).mockReturnValue({top:150,bottom:240,height:90,left:0,right:400,width:400,x:0,y:150,toJSON:()=>({})});
  fireEvent.focus(body);
  expect(area.scrollTop).toBe(100);
  expect(body.value).toBe(item.draft.body); expect([body.selectionStart,body.selectionEnd]).toEqual([2,5]);
  expect(screen.getByRole('textbox',{name:'Email body'})).toBe(body);
});
