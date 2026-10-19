// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { OutcomeForm, currentCallOf, callIdentity, outcomeSessionKey } from '../src/renderer/today/OutcomeForm.tsx';
import { DialPanel } from '../src/renderer/today/Lanes.tsx';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import { todayStateSchema } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';
const firmId = '11111111-1111-4111-8111-111111111111';
const routeId = '22222222-2222-4222-8222-222222222222';
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const oldSession = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const state = (attemptId = a) => todayStateSchema.parse({ snapshotDate: '2026-10-19', businessTimeZone: 'America/New_York', cards: [],
  expanded: { firmId, firmName: 'Fictional Phone Fixture', snapshotDate: '2026-10-19', lane: 'due_work', counts: { replies: 0, emailsDue: 0, callsDue: 0 },
    tasks: [], routes: [{ routeId, contactId: null, e164: '+14015550187', version: 1, eligibility: 'usable' }], callingIdentityId: null },
  online: true, stale: false, asOf: '2026-10-19T14:00:00Z', mayMutate: true, role: 'salesperson', notice: null,
  handoffNotice: 'The phone app cannot report whether this call happened.', dialAdvice: [], followUpTemplates: [],
  lastCall: { firmId, routeId, contactId: null, e164: '+14015550187', callSessionId: null, phoneHandoffAttemptId: attemptId } });
afterEach(() => { cleanup(); globalThis.callieApi = undefined; });
describe('phone-app outcome identity and truthful disclosure', () => {
  it('never substitutes an old Twilio session for the phone attempt', () => {
    const call = currentCallOf(state(), firmId, oldSession);
    expect(call).toMatchObject({ phoneHandoffAttemptId: a, callSessionId: null });
    if (!call) throw new Error('missing call');
    expect(callIdentity(call)).toBe(a);
    expect(outcomeSessionKey({ kind: 'current' }, call)).toBe(a);
  });
  it('has no recording announcement or recorded-outcome claim for a phone handoff', () => {
    const value = state();
    const actions = { busy: () => false, dial: vi.fn(), previewFollowUp: vi.fn(), recordOutcome: vi.fn() } as unknown as TodayActions;
    render(<DraftsProvider><DialPanel state={value} view={buildTodayView(value)} actions={actions} />
      <OutcomeForm state={value} view={buildTodayView(value)} enabled actions={actions} callSessionId={oldSession} /></DraftsProvider>);
    expect(screen.queryByTestId('call-announcement')).toBeNull();
    expect(screen.queryByTestId('outcome-call-session')).toBeNull();
    expect(screen.queryByText(/read aloud|filed with the recording|transcript/i)).toBeNull();
  });
  it('keeps a lost outcome and its command under A, while another handoff to the same route gets B drafts', () => {
    const sent: Record<string, unknown>[] = [];
    const actions = { busy: () => false, previewFollowUp: vi.fn(), recordOutcome: (input: Record<string, unknown>) => {
      sent.push(input); return new Promise(() => undefined);
    } } as unknown as TodayActions;
    const form = (id: string) => { const value = state(id); return <OutcomeForm state={value} view={buildTodayView(value)} enabled actions={actions} />; };
    const drawn = render(<DraftsProvider>{form(a)}</DraftsProvider>);
    fireEvent.change(screen.getByTestId('outcome-select'), { target: { value: 'no_answer' } });
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(sent[0]?.['phoneHandoffAttemptId']).toBe(a);
    expect(sent[0]).not.toHaveProperty('callSessionId');
    drawn.rerender(<DraftsProvider><p>closed</p></DraftsProvider>);
    drawn.rerender(<DraftsProvider>{form(b)}</DraftsProvider>);
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('outcome-unanswered')).toBeNull();
    fireEvent.change(screen.getByTestId('outcome-select'), { target: { value: 'busy' } });
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(sent[1]?.['phoneHandoffAttemptId']).toBe(b);
    expect(sent[0]?.['commandId']).not.toBe(sent[1]?.['commandId']);
  });
});
