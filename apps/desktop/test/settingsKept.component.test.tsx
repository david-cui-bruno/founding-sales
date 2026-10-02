// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import type { StatusRow } from '../src/renderer/homeView.ts';
import { SettingsView } from '../src/renderer/settings/SettingsView.tsx';
import { StatusSection } from '../src/renderer/settings/StatusSection.tsx';
import type { AdminState } from '../src/renderer/settingsContract.ts';
import type { OperationApi, OperationName } from '../src/shared/operations.ts';
import { adminState } from './e2e/support/adminFixtures.ts';
import { fireEvent } from '@testing-library/react';
import { PosturesSection } from '../src/renderer/settings/PosturesSection.tsx';
import { recordedPosture } from './e2e/support/adminFixtures.ts';
import { CallingCalendarSection } from '../src/renderer/settings/CallingCalendarSection.tsx';
import { adminViewOf } from '../src/renderer/settingsView.ts';
import { SendingSection } from '../src/renderer/settings/SendingSection.tsx';

/**
 * S4R: Settings keeps what was typed and says what happened beside the control that earned it.
 *
 *   * criterion 7: an unsaved edit survives Settings → elsewhere → Settings (the drafts store
 *     sits above the route, the view is mounted afresh);
 *   * criterion 6: a command's answer is drawn in the section whose form sent it, never in a
 *     banner under the tabs;
 *   * the routine Status section is drawn from the rows it is given (C0's behaviour).
 */

const guard = createGeneration().guard;
let state: AdminState;
let saved: unknown[];

function install(onSave: (input: unknown) => AdminState): void {
  saved = [];
  const answer = async (operation: OperationName, input: unknown): Promise<unknown> => {
    if (operation === 'settings.show' || operation === 'settings.state') return await Promise.resolve(state);
    if (operation === 'settings.saveSetting') {
      saved.push(input);
      state = onSave(input);
      return await Promise.resolve(state);
    }
    return await Promise.reject(new Error(`unscripted ${operation}`));
  };
  globalThis.callieApi = { read: answer, command: answer } as unknown as OperationApi;
}

function Shell({ onSettings }: { readonly onSettings: boolean }): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <DraftsProvider>
        {onSettings ? (
          <SettingsView
            route={{ name: 'settings', tab: 'administration' }}
            identity="me"
            generation={0}
            guard={guard}
            mailbox={null}
            mailboxWaiting={false}
            hasMailboxBridge={false}
            isAdmin
            onSwitchMailbox={() => undefined}
          />
        ) : (
          <p data-testid="today">Today</p>
        )}
      </DraftsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  state = adminState();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

describe('unsaved edits survive leaving Settings (criterion 7)', () => {
  it('keeps a typed setting, its note, and the holiday calendar being drafted', async () => {
    install(() => state);
    const user = userEvent.setup();
    // One client and one drafts store across the swap, as in the shell: the route changes under them.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (onSettings: boolean): JSX.Element => (
      <QueryClientProvider client={client}>
        <DraftsProvider>
          {onSettings ? (
            <SettingsView
              route={{ name: 'settings', tab: 'administration' }}
              identity="me"
              generation={0}
              guard={guard}
              mailbox={null}
              mailboxWaiting={false}
              hasMailboxBridge={false}
              isAdmin
              onSwitchMailbox={() => undefined}
            />
          ) : (
            <p data-testid="today">Today</p>
          )}
        </DraftsProvider>
      </QueryClientProvider>
    );
    const view = render(tree(true));
    const address = (await screen.findByTestId('field-postal_address-address')) as HTMLInputElement;
    await user.type(address, '1 Example Way');
    await user.type(screen.getByTestId('note-postal_address'), 'moved');
    await user.type(screen.getByTestId('holiday-version'), '2027-draft');

    view.rerender(tree(false));
    expect(screen.queryByTestId('settings-view')).toBeNull();
    view.rerender(tree(true));

    expect(((await screen.findByTestId('field-postal_address-address')) as HTMLInputElement).value).toBe('1 Example Way');
    expect((screen.getByTestId('note-postal_address') as HTMLInputElement).value).toBe('moved');
    expect((screen.getByTestId('holiday-version') as HTMLInputElement).value).toBe('2027-draft');
    // A setting nobody touched still shows what is saved.
    expect((screen.getByTestId('field-business_time_zone-timeZone') as HTMLSelectElement).value).toBe('America/Chicago');
  });
});

describe('what a command said is drawn beside its control (criterion 6)', () => {
  it('puts the answer in the section that sent it, and nowhere else', async () => {
    install(() => ({ ...state, notice: 'admin_only' }));
    const user = userEvent.setup();
    render(<Shell onSettings />);
    await user.type(await screen.findByTestId('field-postal_address-address'), '9 Test Road');
    await user.click(screen.getByTestId('save-postal_address'));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });

    const mine = screen.getByTestId('setting-postal_address');
    await waitFor(() => {
      expect(within(mine).getByTestId('notice').textContent).toBe('admin_only');
    });
    // Not on the page, not under the neighbouring setting.
    expect(screen.getAllByTestId('notice')).toHaveLength(1);
    expect(within(screen.getByTestId('banners')).queryByTestId('notice')).toBeNull();
    expect(within(screen.getByTestId('setting-business_time_zone')).queryByTestId('notice')).toBeNull();
  });

  it('keeps the page banner for an answer no form owns', async () => {
    install(() => state);
    state = adminState({ notice: 'offline' });
    render(<Shell onSettings />);
    const banner = await screen.findByTestId('notice');
    expect(within(screen.getByTestId('banners')).getByTestId('notice')).toBe(banner);
  });
});

describe('Settings › Status', () => {
  it('draws the rows it is given, each with its tone, and no more', () => {
    const rows: StatusRow[] = [
      { key: 'mailbox', text: 'Mailbox connected', tone: 'ok' },
      { key: 'sending', text: 'Sending is paused', tone: 'warn' },
    ];
    render(<StatusSection rows={rows} />);
    const section = screen.getByTestId('settings-status');
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
    expect(within(section).getByTestId('status-mailbox').getAttribute('data-tone')).toBe('ok');
    expect(within(section).getByTestId('status-sending').textContent).toBe('Sending is paused');
  });
});

describe('the sending checklist and caps (criterion 7)', () => {
  const MAILBOX = '33333333-3333-4333-8333-333333333333';
  const sendingAdmin = (cap: number): AdminState['sendingAdmin'] => ({
    domain: {
      domain: 'sending.example.test',
      spfPass: false,
      dkimPass: false,
      dmarcPass: false,
      postmasterReviewedAt: null,
      authenticationPasses: false,
      automatedSendingEnabled: false,
    },
    ramps: [{ mailboxId: MAILBOX, healthySendingDays: 9, effectiveCap: cap, adminDailyCap: cap, raisedDailyCap: null, lastHealthFailure: null }],
  });
  const section = (cap: number, on: boolean): JSX.Element => (
    <DraftsProvider>
      {on ? (
        <SendingSection
          view={adminViewOf(adminState({ sendingAdmin: sendingAdmin(cap) }))}
          recording={false}
          capping={false}
          onRecord={() => undefined}
          onCap={() => undefined}
          onRetry={() => undefined}
        />
      ) : (
        <p>away</p>
      )}
    </DraftsProvider>
  );

  it('keeps a ticked box and a typed cap across a visit elsewhere', async () => {
    const user = userEvent.setup();
    const view = render(section(40, true));
    await user.click(screen.getByTestId('sending-spfPass'));
    await user.clear(screen.getByTestId(`cap-${MAILBOX}`));
    await user.type(screen.getByTestId(`cap-${MAILBOX}`), '25');
    // Same provider across the swap: the route changes under the store, as in the shell.
    view.rerender(section(40, false));
    expect(screen.queryByTestId('sending-spfPass')).toBeNull();
    view.rerender(section(40, true));
    expect((screen.getByTestId('sending-spfPass') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`cap-${MAILBOX}`) as HTMLInputElement).value).toBe('25');
  });

  it('drops the typing when the saved values changed while the person was away', async () => {
    const user = userEvent.setup();
    const view = render(section(40, true));
    await user.click(screen.getByTestId('sending-spfPass'));
    view.rerender(section(40, false));
    // Another admin raised the cap meanwhile: the form shows what is saved now, as it always did.
    view.rerender(section(50, true));
    await waitFor(() => {
      expect((screen.getByTestId(`cap-${MAILBOX}`) as HTMLInputElement).value).toBe('50');
    });
    expect((screen.getByTestId('sending-spfPass') as HTMLInputElement).checked).toBe(false);
  });
});

describe('a kept edit never resubmits a stale server value (K2)', () => {
  const integrations = (dollars: number): NonNullable<AdminState['integrations']> => ({
    callingProvider: 'tel',
    telephonyBudget: { dailyCeilingCents: dollars * 100, maxMinutesPerCall: 30, unitPriceMicros: 14_000 },
    calendarIntegration: 'off',
    voicemailScript: 'Hi {contactFirstName}, it is {callerName}.',
    configured: { twilioVoice: { ok: true, missing: [] }, calcom: { ok: true, missing: [] } },
    spentTodayCents: 0,
  });
  const state = (dollars: number): AdminState => ({ ...adminState(), integrations: integrations(dollars), integrationsNotice: null });

  it('a saved budget cannot override a newer one when only the minutes are changed later', () => {
    const onSave = vi.fn();
    const tree = (on: boolean, dollars: number): JSX.Element => (
      <DraftsProvider>
        {on ? <CallingCalendarSection state={state(dollars)} busy={() => false} onSave={onSave} onRetry={() => undefined} /> : null}
      </DraftsProvider>
    );
    const view = render(tree(true, 5));
    fireEvent.change(screen.getByTestId('budget-dollars'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('budget-save'));
    view.rerender(tree(true, 10)); // accepted: the saved value now says what was typed
    expect(screen.queryByTestId('changed-elsewhere')).toBeNull();
    view.rerender(tree(false, 10));
    view.rerender(tree(true, 2)); // another admin lowered it while away
    fireEvent.change(screen.getByTestId('budget-minutes'), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('budget-save'));
    expect((onSave.mock.calls.at(-1)?.[0] as { value: { dailyCeilingCents: number; maxMinutesPerCall: number } }).value).toMatchObject({
      dailyCeilingCents: 200,
      maxMinutesPerCall: 20,
    });
  });

  it('says it changed elsewhere when an unsaved edit is dropped for a newer server value', () => {
    const tree = (on: boolean, dollars: number): JSX.Element => (
      <DraftsProvider>
        {on ? <CallingCalendarSection state={state(dollars)} busy={() => false} onSave={() => undefined} onRetry={() => undefined} /> : null}
      </DraftsProvider>
    );
    const view = render(tree(true, 5));
    fireEvent.change(screen.getByTestId('budget-dollars'), { target: { value: '9' } });
    view.rerender(tree(false, 5));
    view.rerender(tree(true, 3));
    expect((screen.getByTestId('budget-dollars') as HTMLInputElement).value).toBe('3.00');
    expect(screen.getByTestId('changed-elsewhere')).toBeTruthy();
  });

  it('keeps an unsaved edit while the server value is unchanged', () => {
    const tree = (on: boolean): JSX.Element => (
      <DraftsProvider>
        {on ? <CallingCalendarSection state={state(5)} busy={() => false} onSave={() => undefined} onRetry={() => undefined} /> : null}
      </DraftsProvider>
    );
    const view = render(tree(true));
    fireEvent.change(screen.getByTestId('budget-dollars'), { target: { value: '9' } });
    view.rerender(tree(false));
    view.rerender(tree(true));
    expect((screen.getByTestId('budget-dollars') as HTMLInputElement).value).toBe('9');
  });
});

describe('a consumed posture confirmation is cleared by the success answer (K6)', () => {
  it('does not authorise another state after the form is mounted again', async () => {
    const base = adminState();
    let release: (value: AdminState) => void = () => undefined;
    state = base;
    const answer = async (operation: OperationName): Promise<unknown> => {
      if (operation === 'settings.show' || operation === 'settings.state') return await Promise.resolve(state);
      if (operation === 'settings.allowStates') {
        return await new Promise<AdminState>(resolve => {
          release = resolve;
        });
      }
      return await Promise.reject(new Error(`unscripted ${operation}`));
    };
    globalThis.callieApi = { read: answer, command: answer } as unknown as OperationApi;
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (on: boolean): JSX.Element => (
      <QueryClientProvider client={client}>
        <DraftsProvider>
          {on ? (
            <SettingsView
              route={{ name: 'settings', tab: 'administration' }}
              identity="me"
              generation={0}
              guard={guard}
              mailbox={null}
              mailboxWaiting={false}
              hasMailboxBridge={false}
              isAdmin
              onSwitchMailbox={() => undefined}
            />
          ) : (
            <p>away</p>
          )}
        </DraftsProvider>
      </QueryClientProvider>
    );
    const view = render(tree(true));
    await user.click(await screen.findByTestId('posture-state-AL'));
    await user.click(screen.getByTestId('posture-confirmed'));
    await user.type(screen.getByTestId('posture-note'), 'Checked AL');
    await user.click(screen.getByTestId('posture-record'));
    view.rerender(tree(false));
    // The server records it while the form is gone.
    const afterwards = adminState();
    release({
      ...afterwards,
      notice: 'posture_recorded',
      postures: afterwards.postures === null ? null : { ...afterwards.postures, records: afterwards.postures.records },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    view.rerender(tree(true));
    await user.click(await screen.findByTestId('posture-state-AL'));
    expect((screen.getByTestId('posture-confirmed') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('posture-note') as HTMLTextAreaElement).value).toBe('');
  });
});

describe('a posture confirmation belongs to the states it was given for (K1)', () => {
  it('spent while away, it cannot authorise a later, different state (the section on its own)', () => {
    const onAllow = vi.fn();
    const base = adminState();
    const added: AdminState = {
      ...base,
      postures: base.postures === null ? null : { ...base.postures, records: [...(base.postures.records ?? []), recordedPosture({ id: 'new', state: 'AL' })] },
    };
    const tree = (on: boolean, from: AdminState): JSX.Element => (
      <DraftsProvider>
        {on ? (
          <PosturesSection
            section={adminViewOf(from).postures as NonNullable<ReturnType<typeof adminViewOf>['postures']>}
            adding={false}
            revoking={() => false}
            onAllow={onAllow}
            onRevoke={() => undefined}
            onRetry={() => undefined}
          />
        ) : null}
      </DraftsProvider>
    );
    const view = render(tree(true, base));
    fireEvent.click(screen.getByTestId('posture-state-AL'));
    fireEvent.click(screen.getByTestId('posture-confirmed'));
    fireEvent.change(screen.getByTestId('posture-note'), { target: { value: 'Checked AL' } });
    fireEvent.click(screen.getByTestId('posture-record'));
    expect(onAllow).toHaveBeenCalledTimes(1);
    view.rerender(tree(false, base));
    view.rerender(tree(true, added));
    fireEvent.click(screen.getByTestId('posture-state-TX'));
    expect((screen.getByTestId('posture-confirmed') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('posture-note') as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByTestId('posture-record'));
    expect(onAllow, 'TX needs a fresh confirmation').toHaveBeenCalledTimes(1);
  });
});
