// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUDGET_RANGE,
  CALCOM_NEEDS_SECRET,
  CALLING_NEEDS_BUDGET,
  CALLING_NEEDS_SETUP,
  CallingCalendarSection,
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
