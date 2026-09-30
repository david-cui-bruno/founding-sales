// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { OutcomeForm } from '../src/renderer/today/OutcomeForm.tsx';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import { todayStateSchema, type FollowUpPreviewView, type OutcomeRequest, type TodayState } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';

/**
 * The call card's three follow-up answers (send-path v2, slice S3).
 *
 * David, 30 September 2026: *"Include no email / one approved email / an agreed approved
 * sequence ... Show the messages and timing and record the prospect's agreement."* So an
 * interested call offers exactly three answers, the sequence answer shows the server's
 * preview — each step's message and its date **on the firm's clock** — before the call
 * can be recorded, and what is sent is the version the person heard.
 *
 * The preview here is in Los Angeles while the business zone is New York, so a date
 * formatted on the wrong clock is three hours off and fails.
 *
 * No real person or business appears; `example.test` is reserved by RFC 6761 and the
 * number is in the NANP 555-01XX block.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
const CONTACT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEMPLATE_ID = '66666666-6666-4666-8666-666666666666';
const VERSION_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function baseState(): TodayState {
  return todayStateSchema.parse({
    snapshotDate: '2026-09-30',
    businessTimeZone: 'America/New_York',
    cards: [
      {
        firmId: FIRM_ID,
        firmName: 'Northwind Test Holdings',
        lane: 'due_work',
        dueAt: '2026-09-30T13:00:00.000Z',
        counts: { replies: 0, emailsDue: 0, callsDue: 1 },
      },
    ],
    expanded: {
      firmId: FIRM_ID,
      firmName: 'Northwind Test Holdings',
      snapshotDate: '2026-09-30',
      lane: 'due_work',
      counts: { replies: 0, emailsDue: 0, callsDue: 1 },
      tasks: [],
      routes: [{ routeId: ROUTE_ID, contactId: CONTACT_ID, e164: '+14015550187', version: 1, eligibility: 'usable' }],
      callingIdentityId: null,
    },
    online: true,
    stale: false,
    asOf: '2026-09-30T13:00:00.000Z',
    mayMutate: true,
    role: 'salesperson',
    notice: null,
    handoffNotice: 'Once a call is handed to the phone app, Callie cannot recall it.',
    dialAdvice: [],
    lastCall: { firmId: FIRM_ID, routeId: ROUTE_ID, contactId: CONTACT_ID, e164: '+14015550187' },
    followUpTemplates: [{ id: TEMPLATE_ID, name: 'The overview' }],
    followUpSequences: [{ sequenceVersionId: VERSION_ID, name: 'After a good call v3' }],
  });
}

const PREVIEW: FollowUpPreviewView = {
  firmId: FIRM_ID,
  contactId: CONTACT_ID,
  sequenceVersionId: VERSION_ID,
  sequenceName: 'After a good call',
  firmTimeZone: 'America/Los_Angeles',
  anchoredAt: '2026-09-30T15:00:00.000Z',
  steps: [
    {
      ordinal: 1,
      channel: 'email',
      templateName: 'The overview',
      subject: 'The overview for {firm_name}',
      estimatedAt: '2026-10-02T15:00:00.000Z',
    },
    { ordinal: 2, channel: 'call_task', templateName: null, subject: null, estimatedAt: '2026-10-06T15:00:00.000Z' },
  ],
  refusal: null,
};

interface Harness {
  readonly recorded: OutcomeRequest[];
  readonly previews: unknown[];
}

/** The form with a live state: a preview request answers with `answer` on the next render. */
function mount(answer: FollowUpPreviewView | null): Harness {
  const harness: Harness = { recorded: [], previews: [] };
  function Host(): JSX.Element {
    const [state, setState] = useState<TodayState>(baseState);
    const actions = {
      busy: () => false,
      recordOutcome: (input: OutcomeRequest) => {
        harness.recorded.push(input);
      },
      previewFollowUp: (input: unknown) => {
        harness.previews.push(input);
        setState(current => ({ ...current, followUpPreview: answer }));
      },
    } as unknown as TodayActions;
    return <OutcomeForm state={state} view={buildTodayView(state)} enabled actions={actions} />;
  }
  render(
    <DraftsProvider>
      <Host />
    </DraftsProvider>,
  );
  return harness;
}

const choose = (testId: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};
const submit = (): void => {
  fireEvent.click(screen.getByTestId('outcome-submit'));
};

afterEach(cleanup);

describe('the follow-up an interested call agreed to', () => {
  it('offers exactly none, one approved e-mail and an agreed sequence — and only for a conversation', () => {
    mount(PREVIEW);
    // Not offered before the outcome says a conversation happened.
    expect(screen.getByTestId('outcome-follow-up-label').hidden).toBe(true);
    choose('outcome-select', 'voicemail_left');
    expect(screen.getByTestId('outcome-follow-up-label').hidden).toBe(true);
    choose('outcome-select', 'interested');
    expect(screen.getByTestId('outcome-follow-up-label').hidden).toBe(false);
    const options = [...screen.getByTestId('outcome-follow-up-kind').querySelectorAll('option')].map(option => [
      option.value,
      option.textContent,
    ]);
    expect(options).toEqual([
      ['none', 'No follow-up'],
      ['single_email', 'One approved e-mail'],
      ['agreed_sequence', 'An agreed sequence'],
    ]);
  });

  it('records none as no permission at all', () => {
    const harness = mount(PREVIEW);
    choose('outcome-select', 'interested');
    submit();
    expect(harness.recorded).toHaveLength(1);
    expect(harness.recorded[0]).toMatchObject({ outcome: 'interested', contactId: CONTACT_ID, followUpPermission: null });
    expect(harness.previews).toEqual([]);
  });

  it('records one approved e-mail with the template chosen, and not before one is chosen', () => {
    const harness = mount(PREVIEW);
    choose('outcome-select', 'interested');
    choose('outcome-follow-up-kind', 'single_email');
    expect((screen.getByTestId('outcome-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('outcome-follow-up-problem').textContent).toBe('Choose the e-mail they agreed to.');
    choose('outcome-follow-up', TEMPLATE_ID);
    submit();
    expect(harness.recorded[0]?.followUpPermission).toEqual({ scope: 'single_email', templateVersionId: TEMPLATE_ID });
    expect(harness.previews).toEqual([]);
  });

  it('shows the agreed sequence’s messages and dates on the firm’s clock before it can be recorded', () => {
    const harness = mount(PREVIEW);
    choose('outcome-select', 'interested');
    choose('outcome-follow-up-kind', 'agreed_sequence');
    expect((screen.getByTestId('outcome-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('outcome-follow-up-problem').textContent).toBe('Choose the sequence they agreed to.');
    expect([...screen.getByTestId('outcome-follow-up-sequence').querySelectorAll('option')].map(o => o.textContent)).toEqual([
      'Choose the sequence…',
      'After a good call v3',
    ]);

    choose('outcome-follow-up-sequence', VERSION_ID);
    // The server was asked, once, for this firm, this person and this version.
    expect(harness.previews).toEqual([{ firmId: FIRM_ID, contactId: CONTACT_ID, sequenceVersionId: VERSION_ID }]);
    const whats = screen.getAllByTestId('preview-step-what').map(node => node.textContent);
    const whens = screen.getAllByTestId('preview-step-when').map(node => node.textContent);
    expect(whats).toEqual(['1. E-mail — The overview: “The overview for {firm_name}”', '2. A call']);
    // 15:00Z is 08:00 in Los Angeles (PDT) — not 11:00, which is New York's clock.
    expect(whens).toEqual(['Fri 2 Oct, 08:00 PDT', 'Tue 6 Oct, 08:00 PDT']);

    submit();
    expect(harness.recorded[0]?.followUpPermission).toEqual({ scope: 'agreed_sequence', sequenceVersionId: VERSION_ID });
    expect(harness.previews).toHaveLength(1);
  });

  it('will not record an agreed sequence the server would not preview, and says why', () => {
    const harness = mount({ ...PREVIEW, steps: [], sequenceName: '', firmTimeZone: '', anchoredAt: null, refusal: 'firm_zone_unknown' });
    choose('outcome-select', 'interested');
    choose('outcome-follow-up-kind', 'agreed_sequence');
    choose('outcome-follow-up-sequence', VERSION_ID);
    expect(screen.queryByTestId('outcome-follow-up-preview')).toBeNull();
    expect(screen.getByTestId('outcome-follow-up-problem').textContent).toBe(
      'Callie cannot start that sequence here: the firm’s time zone is not known yet.',
    );
    expect((screen.getByTestId('outcome-submit') as HTMLButtonElement).disabled).toBe(true);
    submit();
    expect(harness.recorded).toEqual([]);
  });
});
