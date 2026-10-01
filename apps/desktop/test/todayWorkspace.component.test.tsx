// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import type { CallControl } from '../src/renderer/calling/useCall.ts';
import type { CallingStatus } from '../src/renderer/calling/useCallingStatus.ts';
import { BasicsEditor } from '../src/renderer/today/BasicsEditor.tsx';
import { CallPanel } from '../src/renderer/today/CallPanel.tsx';
import { LogIncomingDialog } from '../src/renderer/today/LogIncomingDialog.tsx';
import { callProgress } from '../src/renderer/today/callProgress.ts';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';

/**
 * Slice S2's Today states, component by component: the call panel in each phase (blocked,
 * idle, live, ended), the basics editor and its field-level refusals, and Log incoming
 * call. No real firm or number; the number is in the NANP 555-01XX block.
 */

afterEach(cleanup);

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';

const state = (): TodayState => ({
  snapshotDate: '2026-10-01',
  businessTimeZone: 'America/Chicago',
  cards: [{ firmId: FIRM_ID, firmName: 'Elm Fork Test Rentals', lane: 'new_firm', dueAt: '2026-10-01T13:00:00.000Z', counts: { replies: 0, emailsDue: 0, callsDue: 0 } }],
  expanded: {
    firmId: FIRM_ID,
    firmName: 'Elm Fork Test Rentals',
    snapshotDate: '2026-10-01',
    lane: 'new_firm',
    counts: { replies: 0, emailsDue: 0, callsDue: 0 },
    tasks: [],
    routes: [{ routeId: ROUTE_ID, contactId: null, e164: '+12145550142', version: 1, eligibility: 'usable' }],
    callingIdentityId: null,
  },
  online: true,
  stale: false,
  asOf: '2026-10-01T13:00:00.000Z',
  mayMutate: true,
  role: 'admin',
  notice: null,
  handoffNotice: '',
  dialAdvice: [{ routeId: ROUTE_ID, callable: true, reasons: [], e164: '+12145550142', firmLocalTime: '09:40' }],
  followUpTemplates: [],
});

const callOf = (phase: CallControl['state'], overrides: Partial<CallControl> = {}): CallControl => ({
  state: phase,
  muted: false,
  seconds: 75,
  place: vi.fn(),
  toggleMute: vi.fn(),
  hangUp: vi.fn(),
  dismiss: vi.fn(),
  ...overrides,
});

const twilio: CallingStatus = {
  view: { provider: 'twilio', cadence: { unansweredAttempts: 0, nextAttempt: 1, limit: 4, parked: false, refusal: null } },
  resuming: false,
  reload: vi.fn(),
  resume: vi.fn(async () => undefined),
};

const actions = { busy: () => false, expand: vi.fn(), dial: vi.fn() } as unknown as TodayActions;

function panel(call: CallControl, extra: Partial<Parameters<typeof CallPanel>[0]> = {}) {
  const today = state();
  return render(
    <DraftsProvider>
      <CallPanel
        state={today}
        view={buildTodayView(today)}
        actions={actions}
        call={call}
        status={twilio}
        firmId={FIRM_ID}
        blockers={[]}
        progress={null}
        hasNext
        onFix={vi.fn()}
        onNext={vi.fn()}
        onOutcome={vi.fn()}
        {...extra}
      />
    </DraftsProvider>,
  );
}

describe('the call panel', () => {
  it('explains a firm that cannot be called and offers each fix, with no Call button', () => {
    const onFix = vi.fn();
    panel(callOf({ phase: 'idle' }), { blockers: ['no_phone', 'no_location'], onFix });
    expect(screen.getByTestId('call-blocker-no_phone').textContent).toBe('No phone number');
    expect(screen.getByTestId('call-blocker-no_location').textContent).toBe('No location or time zone');
    expect(screen.queryByTestId('dial')).toBeNull();
    fireEvent.click(screen.getByTestId('call-fix-no_location'));
    expect(onFix).toHaveBeenCalledWith('no_location');
  });

  it('idle: the announcement, the number with its advice, the attempt, and Call places only on a press', () => {
    const call = callOf({ phase: 'idle' });
    panel(call);
    expect(screen.getByTestId('call-announcement-text').textContent).toContain('This call is being recorded and transcribed');
    expect(screen.getByTestId('call-attempt').textContent).toBe('Attempt 1 of 4');
    fireEvent.click(screen.getByTestId('dial'));
    expect(call.place).toHaveBeenCalledWith({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID });
  });

  it('connected: the announcement to read aloud first, the timer, mute and hang up, and a note kept as typed', () => {
    const call = callOf({ phase: 'connected', firmId: FIRM_ID, routeId: ROUTE_ID, sessionId: 's', attempt: 1, voicemailScript: null, answeredAt: 0 });
    panel(call);
    expect(screen.getByTestId('call-live').firstElementChild?.nextElementSibling?.getAttribute('data-testid')).toBe('call-announcement');
    expect(screen.getByTestId('call-timer').textContent).toBe('1:15');
    fireEvent.change(screen.getByTestId('call-notes'), { target: { value: 'Ask for Glen' } });
    expect((screen.getByTestId('call-notes') as HTMLTextAreaElement).value).toBe('Ask for Glen');
    fireEvent.click(screen.getByTestId('call-hang-up'));
    expect(call.hangUp).toHaveBeenCalled();
  });

  it('ended: the steps as they stand, Next firm, and the outcome one press away with nothing required', () => {
    const onNext = vi.fn();
    const onOutcome = vi.fn();
    const progress = callProgress(
      {
        sessionId: 's',
        firmId: FIRM_ID,
        status: 'completed',
        startedAt: new Date(Date.now() - 300_000).toISOString(),
        answeredAt: new Date(Date.now() - 290_000).toISOString(),
        endedAt: new Date(Date.now() - 30_000).toISOString(),
        durationSeconds: 240,
        hasRecording: true,
        callLogId: null,
        hasTranscript: false,
      },
      Date.now(),
    );
    panel(callOf({ phase: 'ended', firmId: FIRM_ID, routeId: ROUTE_ID, sessionId: 's', seconds: 240 }), { progress, onNext, onOutcome });
    expect(screen.getByTestId('step-recording').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('step-transcription').getAttribute('data-state')).toBe('pending');
    expect(screen.queryByTestId('outcome-form')).toBeNull();
    fireEvent.click(screen.getByTestId('call-next'));
    expect(onNext).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('call-set-outcome'));
    expect(onOutcome).toHaveBeenCalled();
  });

  it('ended with nobody left to call says so', () => {
    panel(callOf({ phase: 'ended', firmId: FIRM_ID, routeId: ROUTE_ID, sessionId: 's', seconds: 0 }), { hasNext: false });
    expect(screen.getByTestId('call-next').textContent).toBe('No more firms to call');
    expect((screen.getByTestId('call-next') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the basics editor', () => {
  it('sends only what changed, and replaces the number shown', async () => {
    const save = vi.fn(async () => ({ saved: { firmId: FIRM_ID, routeId: ROUTE_ID, locality: null, regionCode: 'TX', timeZone: 'America/Chicago', blockers: [] }, reason: null, issues: [] }));
    const onSaved = vi.fn();
    render(
      <DraftsProvider>
        <BasicsEditor
          firmId={FIRM_ID}
          values={{ locality: null, regionCode: null, timeZone: null }}
          phone={{ routeId: ROUTE_ID, e164: '+12145550142' }}
          focus="regionCode"
          enabled
          onSaved={onSaved}
          onCancel={vi.fn()}
          save={save}
        />
      </DraftsProvider>,
    );
    expect(document.activeElement).toBe(screen.getByTestId('basics-region'));
    fireEvent.change(screen.getByTestId('basics-region'), { target: { value: 'tx' } });
    fireEvent.change(screen.getByTestId('basics-phone'), { target: { value: '(214) 555-0143' } });
    fireEvent.click(screen.getByTestId('basics-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith({ firmId: FIRM_ID, regionCode: 'TX', phone: { number: '(214) 555-0143', replacesRouteId: ROUTE_ID } });
  });

  it('marks every field the server named and keeps what was typed', async () => {
    const save = vi.fn(async () => ({
      saved: null,
      reason: 'invalid_input',
      issues: [
        { field: 'phone' as const, code: 'phone_invalid' as const },
        { field: 'regionCode' as const, code: 'region_code_invalid' as const },
      ],
    }));
    render(
      <DraftsProvider>
        <BasicsEditor firmId={FIRM_ID} values={{ locality: null, regionCode: null, timeZone: null }} phone={null} enabled onSaved={vi.fn()} onCancel={vi.fn()} save={save} />
      </DraftsProvider>,
    );
    fireEvent.change(screen.getByTestId('basics-phone'), { target: { value: '12' } });
    fireEvent.change(screen.getByTestId('basics-region'), { target: { value: 'ZZ' } });
    fireEvent.click(screen.getByTestId('basics-save'));
    await screen.findByTestId('basics-issue-phone');
    expect(screen.getByTestId('basics-issue-regionCode').textContent).toContain('two-letter state code');
    expect((screen.getByTestId('basics-phone') as HTMLInputElement).value).toBe('12');
  });

  it('cannot save when nothing changed', () => {
    render(
      <DraftsProvider>
        <BasicsEditor firmId={FIRM_ID} values={{ locality: 'Dallas', regionCode: 'TX', timeZone: 'America/Chicago' }} phone={null} enabled onSaved={vi.fn()} onCancel={vi.fn()} />
      </DraftsProvider>,
    );
    expect((screen.getByTestId('basics-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Log incoming call', () => {
  const cards = state().cards;
  it('needs an outcome, then logs the firm, the person, the time, the length and the note', async () => {
    const log = vi.fn(async () => ({ logged: true, reason: null }));
    const onLogged = vi.fn();
    const now = Date.parse('2026-10-01T15:30:00.000Z');
    render(
      <DraftsProvider>
        <LogIncomingDialog
          open
          cards={cards}
          firmId={FIRM_ID}
          contactsFor={() => [{ contactId: CONTACT_ID, name: 'Dana Example' }]}
          enabled
          onClose={vi.fn()}
          onLogged={onLogged}
          log={log}
          now={() => now}
        />
      </DraftsProvider>,
    );
    expect((screen.getByTestId('log-incoming-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('incoming-contact'), { target: { value: CONTACT_ID } });
    fireEvent.change(screen.getByTestId('incoming-minutes'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('incoming-outcome'), { target: { value: 'callback_requested' } });
    fireEvent.change(screen.getByTestId('incoming-note'), { target: { value: '  Try Tuesday  ' } });
    fireEvent.click(screen.getByTestId('log-incoming-save'));
    await waitFor(() => expect(onLogged).toHaveBeenCalled());
    expect(log).toHaveBeenCalledWith({
      firmId: FIRM_ID,
      contactId: CONTACT_ID,
      occurredAt: new Date(new Date(now).setSeconds(0, 0)).toISOString(),
      durationSeconds: 180,
      outcome: 'callback_requested',
      note: 'Try Tuesday',
    });
  });

  it('refuses a time in the future before anything is sent, and says a refusal in words', async () => {
    const log = vi.fn(async () => ({ logged: false, reason: 'not_assigned' }));
    render(
      <DraftsProvider>
        <LogIncomingDialog open cards={cards} firmId={FIRM_ID} contactsFor={() => []} enabled onClose={vi.fn()} onLogged={vi.fn()} log={log} />
      </DraftsProvider>,
    );
    fireEvent.change(screen.getByTestId('incoming-outcome'), { target: { value: 'interested' } });
    fireEvent.change(screen.getByTestId('incoming-when'), { target: { value: '2099-01-01T09:00' } });
    expect((screen.getByTestId('log-incoming-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('incoming-when'), { target: { value: '2026-09-30T09:00' } });
    fireEvent.click(screen.getByTestId('log-incoming-save'));
    const refused = await screen.findByTestId('incoming-refused');
    expect(refused.textContent).not.toBe('not_assigned');
  });
});
