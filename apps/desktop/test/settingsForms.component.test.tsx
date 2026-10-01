// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { JSX } from 'react';
import { adminViewOf, finishingSentence } from '../src/renderer/settingsView.ts';
import type { AdminState } from '../src/renderer/settingsContract.ts';
import { SendingSection } from '../src/renderer/settings/SendingSection.tsx';
import { ResearchSettingsSection } from '../src/renderer/settings/ResearchSettingsSection.tsx';
import type { ResearchState } from '../src/renderer/researchContract.ts';

/**
 * Every Settings form starts from what is saved (David, 29 September 2026).
 *
 * The defect this file was written for: the sending checklist's four boxes and the
 * per-mailbox cap started empty however long the workspace had had them recorded, so
 * an admin who opened Settings read "nothing has been checked" about a domain whose
 * checklist the server had held for weeks — and the only way to keep it was to tick
 * all four again. A form that shows a blank where a saved value is is not a cosmetic
 * fault: it invites somebody to re-record a fact they never looked at.
 *
 * Two rules, and they apply to every form on the page:
 *
 *   * **what is saved is what is shown on arrival**, for every control, not only the
 *     text fields;
 *   * **a reload shows the reload's values.** A payload that comes back different —
 *     a save that went through, another admin's change, a Refresh — re-seeds the form.
 *     A payload that comes back the same leaves what somebody is half-way through
 *     typing alone, which is why the seed is keyed on the saved values themselves and
 *     not on the identity of the object carrying them.
 *
 * Fictional data only: `example.test` is reserved by RFC 6761.
 */

const MAILBOX_ID = '33333333-3333-4333-8333-333333333333';

const adminState = (sendingAdmin: AdminState['sendingAdmin']): AdminState => ({
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
  sendingAdmin,
  sendingReadError: null,
  callingNumbers: [],
  postures: null,
});

const recorded: AdminState['sendingAdmin'] = {
  domain: {
    domain: 'sending.example.test',
    spfPass: true,
    dkimPass: true,
    dmarcPass: true,
    postmasterReviewedAt: '2026-09-20T12:00:00.000Z',
    authenticationPasses: true,
    automatedSendingEnabled: false,
  },
  ramps: [
    {
      mailboxId: MAILBOX_ID,
      healthySendingDays: 9,
      effectiveCap: 40,
      adminDailyCap: 40,
      raisedDailyCap: null,
      lastHealthFailure: null,
    },
  ],
};

const noop = (): void => undefined;

const sending = (state: AdminState['sendingAdmin']): JSX.Element => (
  <SendingSection
    view={adminViewOf(adminState(state))}
    recording={false}
    capping={false}
    onRecord={noop}
    onCap={noop}
    onRetry={noop}
  />
);

const box = (name: string): HTMLInputElement => screen.getByTestId(`sending-${name}`) as HTMLInputElement;
const capField = (): HTMLInputElement => screen.getByTestId(`cap-${MAILBOX_ID}`) as HTMLInputElement;

afterEach(cleanup);

describe('the sending domain checklist', () => {
  it('opens with the checklist the server has recorded, and the cap in force', () => {
    render(sending(recorded));

    expect(box('spfPass').checked).toBe(true);
    expect(box('dkimPass').checked).toBe(true);
    expect(box('dmarcPass').checked).toBe(true);
    expect(box('postmasterReviewed').checked).toBe(true);
    // The fifth is its own fact and it is not enabled here: a form that ticked it
    // because the other four pass would be the page deciding 12.7's enable.
    expect(box('automatedSendingEnabled').checked).toBe(false);
    expect(capField().value).toBe('40');
  });

  it('leaves a box unticked when the server has not recorded it', () => {
    render(
      sending({
        domain: { ...recorded.domain!, dmarcPass: false, postmasterReviewedAt: null, authenticationPasses: false },
        ramps: recorded.ramps,
      }),
    );

    expect(box('spfPass').checked).toBe(true);
    expect(box('dmarcPass').checked).toBe(false);
    expect(box('postmasterReviewed').checked).toBe(false);
  });

  it('shows the reloaded values when the payload changes under it', () => {
    const { rerender } = render(sending({ domain: { ...recorded.domain!, dmarcPass: false, authenticationPasses: false }, ramps: recorded.ramps }));
    expect(box('dmarcPass').checked).toBe(false);

    // The save went through and the page read the status again.
    rerender(sending({ domain: recorded.domain, ramps: [{ ...recorded.ramps[0]!, effectiveCap: 50, adminDailyCap: 50 }] }));

    expect(box('dmarcPass').checked).toBe(true);
    expect(capField().value).toBe('50');
  });
});

describe('the research settings form', () => {
  // Every key `/research/settings` answers with, including the ones this section does
  // not draw: a fixture carrying only what the page reads proves only that the page
  // agrees with itself.
  const researchState = (overrides: Partial<ResearchState> = {}): ResearchState => ({
    firm: null,
    settings: {
      enabled: true,
      dailyFirmCeiling: 25,
      dailyCostCeilingCents: 300,
      monthlyCostCeilingCents: 5000,
      maxPagesPerFirm: 8,
      maxPageBytes: 1_000_000,
      modelName: 'claude-haiku-4-5',
      updatedByUserId: null,
      updatedAt: null,
    },
    worstCaseRunCents: 4,
    spend: { todayCents: 4, monthToDateCents: 37 },
    notice: null,
    mayMutate: true,
    role: 'admin',
    ...overrides,
  });

  const field = (name: string): HTMLInputElement => screen.getByTestId(`research-${name}`) as HTMLInputElement;

  it('opens with the saved ceilings rather than empty fields', () => {
    render(<ResearchSettingsSection state={researchState()} saving={false} onSave={noop} />);

    expect(field('enabled').checked).toBe(true);
    expect(field('dailyFirmCeiling').value).toBe('25');
    expect(field('dailyCostCeilingCents').value).toBe('300');
    expect(field('monthlyCostCeilingCents').value).toBe('5000');
    expect(field('maxPagesPerFirm').value).toBe('8');
  });

  it('shows the values a second read came back with', async () => {
    const { rerender } = render(<ResearchSettingsSection state={researchState()} saving={false} onSave={noop} />);
    rerender(
      <ResearchSettingsSection
        state={researchState({ settings: { ...researchState().settings!, monthlyCostCeilingCents: 9000 } })}
        saving={false}
        onSave={noop}
      />,
    );

    await waitFor(() => {
      expect(field('monthlyCostCeilingCents').value).toBe('9000');
    });
  });
});

// Slice P1, invariant I1: a switch is off, and what was already submitted is finishing.
describe('the finishing line', () => {
  it('says what is finishing only while the switch is off, in the singular and the plural', () => {
    expect(finishingSentence('sending', { on: false, finishing: 1 })).toBe('Sending is off. 1 message already submitted is finishing.');
    expect(finishingSentence('sending', { on: false, finishing: 2 })).toBe('Sending is off. 2 messages already submitted are finishing.');
    expect(finishingSentence('research', { on: false, finishing: 1 })).toBe('Research is off. 1 research run already under way is finishing.');
    expect(finishingSentence('sending', { on: true, finishing: 3 })).toBeNull();
    expect(finishingSentence('sending', { on: false, finishing: 0 })).toBeNull();
    expect(finishingSentence('research', null)).toBeNull();
    expect(finishingSentence('research', undefined)).toBeNull();
  });

  it('shows it in Settings → Sending', () => {
    render(sending({ ...recorded, finishing: { on: false, finishing: 1 } }));
    expect(screen.getByTestId('sending-finishing').textContent).toBe('Sending is off. 1 message already submitted is finishing.');
    cleanup();
    render(sending({ ...recorded, finishing: { on: true, finishing: 1 } }));
    expect(screen.queryByTestId('sending-finishing')).toBeNull();
    cleanup();
    render(sending(recorded));
    expect(screen.queryByTestId('sending-finishing')).toBeNull();
  });

  it('shows it in Settings → Research', () => {
    const state: ResearchState = {
      firm: null,
      settings: {
        enabled: false,
        dailyFirmCeiling: 25,
        dailyCostCeilingCents: 300,
        monthlyCostCeilingCents: 5000,
        maxPagesPerFirm: 8,
        maxPageBytes: 1_000_000,
        modelName: 'claude-haiku-4-5',
        updatedByUserId: null,
        updatedAt: null,
      },
      worstCaseRunCents: 4,
      spend: null,
      notice: null,
      mayMutate: true,
      role: 'admin',
      finishing: { on: false, finishing: 2 },
    };
    render(<ResearchSettingsSection state={state} saving={false} onSave={noop} />);
    expect(screen.getByTestId('research-finishing').textContent).toBe('Research is off. 2 research runs already under way are finishing.');
  });
});
