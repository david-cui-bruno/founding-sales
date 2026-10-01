// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUDGET_RANGE,
  CALCOM_NEEDS_SECRET,
  CALLING_NEEDS_BUDGET,
  CALLING_NEEDS_SETUP,
  CallingCalendarSection,
  MONTH_RANGE,
  TRANSCRIPTION_BUDGET_RANGE,
  TRANSCRIPTION_NEEDS_BUDGET,
  TRANSCRIPTION_NEEDS_KEY,
  centsFromDollars,
} from '../src/renderer/settings/CallingCalendarSection.tsx';
import type { AdminState, SaveIntegrationInput } from '../src/renderer/settingsContract.ts';

/**
 * Settings → Calling & calendar (slice S1): each row's on/off, its disabled state with
 * the reason, and a save that comes back refused with its sentence. Fictional data only.
 */

const integrations = (overrides: Partial<NonNullable<AdminState['integrations']>> = {}): NonNullable<AdminState['integrations']> => ({
  callingProvider: 'tel',
  telephonyBudget: { dailyCeilingCents: 500, maxMinutesPerCall: 30, unitPriceMicros: 14_000 },
  calendarIntegration: 'off',
  voicemailScript: 'Hi {contactFirstName}, it is {callerName}.',
  configured: { twilioVoice: { ok: true, missing: [] }, calcom: { ok: true, missing: [] } },
  spentTodayCents: 125,
  ...overrides,
});

const stateOf = (overrides: Partial<AdminState> = {}): AdminState => ({
  screen: 'settings',
  role: 'admin',
  online: true,
  mayMutate: true,
  notice: null,
  settings: null,
  dashboard: null,
  diagnostics: null,
  stages: [],
  history: null,
  sendingAdmin: null,
  sendingReadError: null,
  callingNumbers: [],
  postures: null,
  integrations: integrations(),
  integrationsNotice: null,
  ...overrides,
});

function show(state: AdminState, busy: (key: SaveIntegrationInput['settingKey']) => boolean = () => false) {
  const onSave = vi.fn<(input: SaveIntegrationInput) => void>();
  const onRetry = vi.fn();
  const view = render(<CallingCalendarSection state={state} busy={busy} onSave={onSave} onRetry={onRetry} />);
  return { onSave, onRetry, view };
}

afterEach(cleanup);

describe('In-app calling', () => {
  it('turns on with credentials present and a ceiling above zero, and off again', () => {
    const on = show(stateOf());
    fireEvent.click(screen.getByTestId('calling-switch'));
    expect(on.onSave).toHaveBeenCalledWith({ settingKey: 'calling_provider', value: { provider: 'twilio' } });
    cleanup();
    const off = show(stateOf({ integrations: integrations({ callingProvider: 'twilio' }) }));
    expect((screen.getByTestId('calling-switch') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('calling-switch'));
    expect(off.onSave).toHaveBeenCalledWith({ settingKey: 'calling_provider', value: { provider: 'tel' } });
  });

  it('cannot be turned on without the account, says so in one sentence, and names no field', () => {
    show(
      stateOf({
        integrations: integrations({
          configured: { twilioVoice: { ok: false, missing: ['auth_token', 'caller_id_e164'] }, calcom: { ok: true, missing: [] } },
        }),
      }),
    );
    expect((screen.getByTestId('calling-switch') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('calling-detail').textContent).toBe(CALLING_NEEDS_SETUP);
    expect(document.body.textContent).not.toContain('auth_token');
    expect(document.body.textContent).not.toContain('caller_id');
  });

  it('cannot be turned on with a ceiling of zero: calling stays off until a daily budget is set', () => {
    show(stateOf({ integrations: integrations({ telephonyBudget: { dailyCeilingCents: 0, maxMinutesPerCall: 30, unitPriceMicros: 14_000 } }) }));
    expect((screen.getByTestId('calling-switch') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('calling-detail').textContent).toBe(CALLING_NEEDS_BUDGET);
  });

  it('can still be turned off when the account or the budget has gone away', () => {
    const { onSave } = show(
      stateOf({
        integrations: integrations({
          callingProvider: 'twilio',
          telephonyBudget: { dailyCeilingCents: 0, maxMinutesPerCall: 30, unitPriceMicros: 14_000 },
          configured: { twilioVoice: { ok: false, missing: ['auth_token'] }, calcom: { ok: true, missing: [] } },
        }),
      }),
    );
    expect(screen.getByTestId('calling-budget-warning').textContent).toBe(CALLING_NEEDS_BUDGET);
    fireEvent.click(screen.getByTestId('calling-switch'));
    expect(onSave).toHaveBeenCalledWith({ settingKey: 'calling_provider', value: { provider: 'tel' } });
  });

  it('is inert offline', () => {
    show(stateOf({ mayMutate: false }));
    expect((screen.getByTestId('calling-switch') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('budget-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Daily calling budget', () => {
  it('shows today’s spend, saves dollars as cents with the price kept, and the advanced minutes travel with it', () => {
    const { onSave } = show(stateOf());
    expect(screen.getByTestId('budget-detail').textContent).toContain('Spent today $1.25');
    fireEvent.change(screen.getByTestId('budget-dollars'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByTestId('budget-minutes'), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('budget-save'));
    expect(onSave).toHaveBeenCalledWith({
      settingKey: 'telephony_budget',
      value: { dailyCeilingCents: 1250, maxMinutesPerCall: 20, unitPriceMicros: 14_000 },
    });
  });

  it('refuses an amount outside $0–$100 before sending anything', () => {
    const { onSave } = show(stateOf());
    fireEvent.change(screen.getByTestId('budget-dollars'), { target: { value: '100.01' } });
    expect(screen.getByTestId('budget-issue').textContent).toBe(BUDGET_RANGE);
    expect((screen.getByTestId('budget-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('budget-save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(centsFromDollars('100')).toBe(10_000);
    expect(centsFromDollars('0')).toBe(0);
    expect(centsFromDollars('-1')).toBeNull();
    expect(centsFromDollars('abc')).toBeNull();
  });
});

describe('Voicemail script', () => {
  it('lists the placeholders, saves the edit, and will not save an empty script', () => {
    const { onSave } = show(stateOf());
    expect(screen.getByTestId('voicemail-placeholders').textContent).toContain('{contactFirstName}');
    expect(screen.getByTestId('voicemail-placeholders').textContent).toContain('{callbackNumber}');
    expect((screen.getByTestId('voicemail-script') as HTMLTextAreaElement).maxLength).toBe(2000);
    expect((screen.getByTestId('voicemail-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('voicemail-script'), { target: { value: 'Hello {firmName}.' } });
    fireEvent.click(screen.getByTestId('voicemail-save'));
    expect(onSave).toHaveBeenCalledWith({ settingKey: 'voicemail_script', value: { template: 'Hello {firmName}.' } });
    fireEvent.change(screen.getByTestId('voicemail-script'), { target: { value: '   ' } });
    expect((screen.getByTestId('voicemail-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Cal.com bookings', () => {
  it('turns on and off', () => {
    const on = show(stateOf());
    fireEvent.click(screen.getByTestId('calcom-switch'));
    expect(on.onSave).toHaveBeenCalledWith({ settingKey: 'calendar_integration', value: { integration: 'calcom' } });
    cleanup();
    const off = show(stateOf({ integrations: integrations({ calendarIntegration: 'calcom' }) }));
    fireEvent.click(screen.getByTestId('calcom-switch'));
    expect(off.onSave).toHaveBeenCalledWith({ settingKey: 'calendar_integration', value: { integration: 'off' } });
  });

  it('cannot be turned on while the webhook secret is missing, and says why', () => {
    show(
      stateOf({
        integrations: integrations({
          configured: { twilioVoice: { ok: true, missing: [] }, calcom: { ok: false, missing: ['webhook_secret'] } },
        }),
      }),
    );
    expect((screen.getByTestId('calcom-switch') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('calcom-detail').textContent).toBe(CALCOM_NEEDS_SECRET);
  });
});

describe('a refusal', () => {
  it('is shown as its sentence, never as the code', () => {
    show(stateOf({ integrationsNotice: 'admin_only' }));
    expect(screen.getByTestId('calling-calendar-notice').textContent).toBe('Only an administrator can do that. Ask one to do it for you.');
    cleanup();
    show(stateOf({ integrationsNotice: 'invalid_value' }));
    expect(screen.getByTestId('calling-calendar-notice').textContent).toBe('Callie could not use that value. Check it and try again.');
    expect(document.body.textContent).not.toContain('invalid_value');
  });
});

describe('the section’s presence', () => {
  it('is absent for a salesperson', () => {
    show(stateOf({ role: 'salesperson', integrations: null }));
    expect(screen.queryByTestId('calling-calendar')).toBeNull();
  });

  it('says it could not read and offers Retry when the read failed', () => {
    const { onRetry } = show(stateOf({ integrations: null }));
    expect(screen.getByTestId('calling-calendar-unread')).toBeTruthy();
    fireEvent.click(screen.getByTestId('calling-calendar-retry'));
    expect(onRetry).toHaveBeenCalled();
  });
});

// Slice C2: "Transcribe calls" and the daily transcription budget.
describe('Transcribe calls', () => {
  const transcription = (overrides: Partial<NonNullable<NonNullable<AdminState['integrations']>['transcription']>> = {}) => ({
    setting: { enabled: false, dailyCeilingCents: 200, unitPriceMicros: 4_300 },
    configured: { ok: true, missing: [] },
    spentTodayCents: 3,
    ...overrides,
  });

  it('is absent when the server did not answer it (an API from before C2)', () => {
    show(stateOf());
    expect(screen.queryByTestId('row-transcription')).toBeNull();
  });

  it('turns on with the key in place and a budget, keeping the budget and price', () => {
    const { onSave } = show(stateOf({ integrations: integrations({ transcription: transcription() }) }));
    expect(screen.getByTestId('transcription-detail').textContent).toBe('Calls are recorded but not transcribed.');
    fireEvent.click(screen.getByTestId('transcription-switch'));
    expect(onSave).toHaveBeenCalledWith({
      settingKey: 'call_transcription',
      value: { enabled: true, dailyCeilingCents: 200, unitPriceMicros: 4_300 },
    });
    expect(screen.getByTestId('transcription-budget-detail').textContent).toContain('Spent today $0.03.');
  });

  it('is disabled with a sentence while the key is missing, and the budget with it', () => {
    show(stateOf({ integrations: integrations({ transcription: transcription({ configured: { ok: false, missing: ['api_key'] } }) }) }));
    expect((screen.getByTestId('transcription-switch') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('transcription-detail').textContent).toBe(TRANSCRIPTION_NEEDS_KEY);
    expect((screen.getByTestId('transcription-budget-dollars') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('transcription-budget-detail').textContent).toBe(TRANSCRIPTION_NEEDS_KEY);
    // The field name is never shown.
    expect(document.body.textContent).not.toContain('api_key');
  });

  it('stays off until a budget is set, and can always be turned off', () => {
    show(stateOf({ integrations: integrations({ transcription: transcription({ setting: { enabled: false, dailyCeilingCents: 0, unitPriceMicros: 4_300 } }) }) }));
    expect(screen.getByTestId('transcription-detail').textContent).toBe(TRANSCRIPTION_NEEDS_BUDGET);
    expect((screen.getByTestId('transcription-switch') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    const { onSave } = show(
      stateOf({ integrations: integrations({ transcription: transcription({ setting: { enabled: true, dailyCeilingCents: 200, unitPriceMicros: 4_300 }, configured: { ok: false, missing: ['api_key'] } }) }) }),
    );
    fireEvent.click(screen.getByTestId('transcription-switch'));
    expect(onSave).toHaveBeenCalledWith({ settingKey: 'call_transcription', value: { enabled: false, dailyCeilingCents: 200, unitPriceMicros: 4_300 } });
  });

  it('saves the daily budget in dollars, from $0 to $5', () => {
    const { onSave } = show(stateOf({ integrations: integrations({ transcription: transcription() }) }));
    fireEvent.change(screen.getByTestId('transcription-budget-dollars'), { target: { value: '5.01' } });
    expect(screen.getByTestId('transcription-budget-issue').textContent).toBe(TRANSCRIPTION_BUDGET_RANGE);
    expect((screen.getByTestId('transcription-budget-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('transcription-budget-dollars'), { target: { value: '1.50' } });
    fireEvent.click(screen.getByTestId('transcription-budget-save'));
    expect(onSave).toHaveBeenCalledWith({ settingKey: 'call_transcription', value: { enabled: false, dailyCeilingCents: 150, unitPriceMicros: 4_300 } });
  });
});

// Slice P1, invariant I1: transcription and reply reading still finishing after a turn-off.
describe('the paid finishing lines', () => {
  it('shows transcription and reply reading in flight while their switch is off, and nothing otherwise', () => {
    show(
      stateOf({
        integrations: integrations(),
        paidFinishing: { transcription: { on: false, finishing: 1 }, classification: { on: false, finishing: 1 } },
      }),
    );
    expect(screen.getAllByTestId('paid-finishing').map(line => line.textContent)).toEqual([
      'Transcription is off. 1 transcription already sent is finishing.',
      'Reply reading is off. 1 reply already sent to the model is finishing.',
    ]);
  });

  it('is absent while the switches are on or the read did not answer', () => {
    show(stateOf({ integrations: integrations(), paidFinishing: { transcription: { on: true, finishing: 2 } } }));
    expect(screen.queryByTestId('paid-finishing')).toBeNull();
  });
});

// Slice P1, invariant I2: the month's cash limit, and what the month has cost against it.
describe('the monthly spending limit', () => {
  it('is absent when the server does not answer it', () => {
    show(stateOf());
    expect(screen.queryByTestId('row-month')).toBeNull();
  });

  it('shows "this month: $x of $y" and saves the limit in cents', () => {
    const { onSave } = show(stateOf({ integrations: integrations({ month: { ceilingCents: 2_500, spentMonthCents: 340 } }) }));
    expect(screen.getByTestId('month-detail').textContent).toBe(
      'This month: $3.40 of $25.00. Calls, transcription, research and reply reading stop when the limit is reached.',
    );
    const field = screen.getByTestId('month-dollars') as HTMLInputElement;
    expect(field.value).toBe('25.00');
    expect((screen.getByTestId('month-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: '40' } });
    fireEvent.click(screen.getByTestId('month-save'));
    expect(onSave).toHaveBeenCalledWith({ settingKey: 'monthly_cash_ceiling_cents', value: { cents: 4_000 } });
  });

  it('shows the month’s credit-funded cost on its own line, apart from the cash (slice C3a)', () => {
    show(stateOf({ integrations: integrations({ month: { ceilingCents: 2_500, spentMonthCents: 340, creditsMonthCents: 12 } }) }));
    expect(screen.getByTestId('month-detail').textContent).toBe(
      'This month: $3.40 of $25.00. Calls, transcription, research and reply reading stop when the limit is reached.',
    );
    expect(screen.getByTestId('month-credits').textContent).toBe(
      'Credits this month: $0.12. Transcription paid from AWS credits is not counted against the limit.',
    );
  });

  it('shows no credits line for a server that does not answer it', () => {
    show(stateOf({ integrations: integrations({ month: { ceilingCents: 2_500, spentMonthCents: 340 } }) }));
    expect(screen.queryByTestId('month-credits')).toBeNull();
  });

  it('refuses an amount over $50 before it is sent', () => {
    const { onSave } = show(stateOf({ integrations: integrations({ month: { ceilingCents: 2_500, spentMonthCents: 0 } }) }));
    fireEvent.change(screen.getByTestId('month-dollars'), { target: { value: '50.01' } });
    expect(screen.getByTestId('month-issue').textContent).toBe(MONTH_RANGE);
    expect((screen.getByTestId('month-save') as HTMLButtonElement).disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });
});
