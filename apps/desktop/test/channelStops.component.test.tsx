// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { firmPageResponseSchema, type FirmPageResponse } from '@fss/contracts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { FirmPage } from '../src/renderer/firms/FirmPage.tsx';
import { OutcomeForm } from '../src/renderer/today/OutcomeForm.tsx';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import { todayStateSchema, type OutcomeRequest, type TodayState } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';
import { assigneeFirmPage } from './e2e/support/crmFixtures.ts';

/**
 * Channel-specific stops on the desktop (migration 0037, DESIGN-S3X §2.5 and §3.6, David's
 * P1 and P2 of 2 October 2026):
 *
 *  * the outcome form's "Do not call" offers four stops, calls to this person first, and
 *    sends exactly the one chosen; the choice is a kept draft of this firm's form;
 *  * the firm page shows "Email stopped", "Calls stopped" or "All contact stopped" on the
 *    firm and on each contact, from the negotiated `stops`, and nothing without it.
 *
 * No real person or business; `example.test` is reserved and the number is 555-01XX.
 */

afterEach(cleanup);

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
const CONTACT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function baseState(): TodayState {
  return todayStateSchema.parse({
    snapshotDate: '2026-10-02',
    businessTimeZone: 'America/New_York',
    cards: [
      {
        firmId: FIRM_ID,
        firmName: 'Northwind Test Holdings',
        lane: 'due_work',
        dueAt: '2026-10-02T13:00:00.000Z',
        counts: { replies: 0, emailsDue: 0, callsDue: 1 },
      },
    ],
    expanded: {
      firmId: FIRM_ID,
      firmName: 'Northwind Test Holdings',
      snapshotDate: '2026-10-02',
      lane: 'due_work',
      counts: { replies: 0, emailsDue: 0, callsDue: 1 },
      tasks: [],
      routes: [{ routeId: ROUTE_ID, contactId: CONTACT_ID, e164: '+14015550187', version: 1, eligibility: 'usable' }],
      callingIdentityId: null,
    },
    online: true,
    stale: false,
    asOf: '2026-10-02T13:00:00.000Z',
    mayMutate: true,
    role: 'salesperson',
    notice: null,
    handoffNotice: 'Once a call is handed to the phone app, Callie cannot recall it.',
    dialAdvice: [],
    lastCall: { firmId: FIRM_ID, routeId: ROUTE_ID, contactId: CONTACT_ID, e164: '+14015550187' },
    followUpTemplates: [],
    followUpSequences: [],
  });
}

/** The form inside a shell whose drafts outlive it; `shown` unmounts and remounts it. */
function mountForm(): { readonly recorded: OutcomeRequest[]; toggle(): void } {
  const recorded: OutcomeRequest[] = [];
  let flip: () => void = () => undefined;
  function Host(): JSX.Element {
    const [shown, setShown] = useState(true);
    flip = () => setShown(current => !current);
    const state = baseState();
    const actions = {
      busy: () => false,
      recordOutcome: (input: OutcomeRequest) => {
        recorded.push(input);
      },
      previewFollowUp: () => undefined,
    } as unknown as TodayActions;
    return shown ? <OutcomeForm state={state} view={buildTodayView(state)} enabled actions={actions} /> : <p>away</p>;
  }
  render(
    <DraftsProvider>
      <Host />
    </DraftsProvider>,
  );
  return {
    recorded,
    toggle: () => {
      act(() => {
        flip();
      });
    },
  };
}

const choose = (testId: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};

describe('the outcome form’s "Do not call"', () => {
  it('offers the four stops, calls to this person by default, and sends that default', () => {
    const form = mountForm();
    expect(screen.queryByTestId('do-not-call-choice')).toBeNull();
    choose('outcome-select', 'do_not_call');
    const select = screen.getByTestId('do-not-call-choice') as HTMLSelectElement;
    expect(select.value).toBe('contact_phone');
    expect([...select.querySelectorAll('option')].map(option => [option.value, option.textContent])).toEqual([
      ['contact_phone', 'Calls to this person'],
      ['contact_all', 'All contact with this person'],
      ['firm_phone', 'Calls to anyone at this firm'],
      ['firm_all', 'All contact with this firm'],
    ]);
    expect(screen.getByTestId('outcome-warning').textContent).toContain('does not stop e-mail');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(form.recorded).toHaveLength(1);
    expect(form.recorded[0]).toMatchObject({ outcome: 'do_not_call', doNotCall: { scope: 'contact', channel: 'phone' } });
    // The 1.0.29 checkbox is never set by this form: the choice travels as doNotCall.
    expect(form.recorded[0]?.doNotCallCoversAllContact).toBe(false);
  });

  it('sends exactly the stop chosen', () => {
    for (const [key, choice] of [
      ['contact_all', { scope: 'contact', channel: 'all' }],
      ['firm_phone', { scope: 'firm', channel: 'phone' }],
      ['firm_all', { scope: 'firm', channel: 'all' }],
    ] as const) {
      cleanup();
      const form = mountForm();
      choose('outcome-select', 'do_not_call');
      choose('do-not-call-choice', key);
      fireEvent.click(screen.getByTestId('outcome-submit'));
      expect(form.recorded[0]?.doNotCall, key).toEqual(choice);
    }
  });

  it('keeps the choice across a remount of the form, as a draft of this firm', () => {
    const form = mountForm();
    choose('outcome-select', 'do_not_call');
    choose('do-not-call-choice', 'firm_phone');
    form.toggle();
    expect(screen.queryByTestId('do-not-call-choice')).toBeNull();
    form.toggle();
    expect((screen.getByTestId('do-not-call-choice') as HTMLSelectElement).value).toBe('firm_phone');
  });

  it('sends no stop with any other outcome, whatever the choice was left at', () => {
    const form = mountForm();
    choose('outcome-select', 'do_not_call');
    choose('do-not-call-choice', 'firm_all');
    choose('outcome-select', 'voicemail_left');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(form.recorded[0]?.outcome).toBe('voicemail_left');
    expect(form.recorded[0]?.doNotCall).toBeUndefined();
  });
});

type Page = Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>;
const DANA = '66666666-6666-4666-8666-666666666666';
const ROBIN = '77777777-7777-4777-8777-777777777777';

function draw(page: Page): void {
  render(
    <FirmPage
      page={page}
      sequences={null}
      actionsEnabled
      busy={() => false}
      redactionNotice={null}
      onSaveContact={() => undefined}
      onCheckRoute={() => undefined}
      onOpenOpportunity={() => undefined}
      onEnroll={() => undefined}
      onTakeOver={() => undefined}
    />,
  );
}

function withStops(stops: Page['stops']): Page {
  // Through the wire schema, so the fixture is a shape the API may really send.
  return firmPageResponseSchema.parse({ ...(assigneeFirmPage() as Page), ...(stops === undefined ? {} : { stops }) }) as Page;
}

const contactRow = (contactId: string): HTMLElement => {
  const row = screen.getAllByTestId('contact-row').find(element => element.getAttribute('data-contact-id') === contactId);
  if (row === undefined) throw new Error(`no row for ${contactId}`);
  return row;
};

describe('the firm page’s stop badges', () => {
  it('says "Email stopped" for an e-mail opt-out, "Calls stopped" for a do-not-call', () => {
    draw(withStops({ firm: ['email'], contacts: [{ contactId: DANA, email: true, phone: false }, { contactId: ROBIN, email: false, phone: true }] }));
    expect(screen.getByTestId('firm-stop').textContent).toBe('Email stopped');
    expect(within(contactRow(DANA)).getByTestId('contact-stop').textContent).toBe('Email stopped');
    expect(within(contactRow(ROBIN)).getByTestId('contact-stop').textContent).toBe('Calls stopped');
  });

  it('says "All contact stopped" when both channels are stopped, by one stop or two', () => {
    draw(withStops({ firm: ['email', 'phone'], contacts: [{ contactId: DANA, email: true, phone: true }] }));
    expect(screen.getByTestId('firm-stop').textContent).toBe('All contact stopped');
    expect(within(contactRow(DANA)).getByTestId('contact-stop').textContent).toBe('All contact stopped');
    expect(within(contactRow(ROBIN)).queryByTestId('contact-stop')).toBeNull();
    cleanup();
    draw(withStops({ firm: ['all'], contacts: [] }));
    expect(screen.getByTestId('firm-stop').textContent).toBe('All contact stopped');
  });

  it('shows no badge when nothing is stopped, or when the read did not negotiate stops', () => {
    draw(withStops({ firm: [], contacts: [] }));
    expect(screen.queryByTestId('firm-stop')).toBeNull();
    expect(screen.queryByTestId('contact-stop')).toBeNull();
    cleanup();
    draw(withStops(undefined));
    expect(screen.queryByTestId('firm-stop')).toBeNull();
    expect(screen.queryByTestId('contact-stop')).toBeNull();
  });
});
