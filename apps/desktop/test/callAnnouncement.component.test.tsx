// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CALL_ANNOUNCEMENT, CALL_ANNOUNCEMENT_LABEL, type CallBriefDto } from '@fss/contracts';
import { Brief } from '../src/renderer/research/Brief.tsx';
import { DialPanel, type DialCalling } from '../src/renderer/today/Lanes.tsx';
import type { TodayState } from '../src/renderer/todayContract.ts';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayScreenView } from '../src/renderer/todayView.ts';

/** Recording disclosure is shown only with established Twilio recording mode.
 * Phone-app and waiting paths must not claim recording or transcription.
 * Synthetic firms and NANP 555-01XX numbers only.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '22222222-2222-4222-8222-222222222222';

const brief = (): CallBriefDto =>
  ({
    whyFit: [],
    whatChanged: [],
    likelyPerson: null,
    questions: null,
    opening: null,
    generated: false,
    judgments: { fit: 'yes', problemEvidence: 'unknown', timing: 'unknown', reachability: 'yes' },
    judgedAt: '2026-09-28T14:00:00.000Z',
    revision: 1,
    sources: [],
    failedTries: 1,
  }) as unknown as CallBriefDto;

const state = {
  expanded: { firmId: FIRM_ID },
  handoffNotice: 'Once a call is handed to the phone app, Callie cannot recall it.',
} as unknown as TodayState;

const view = {
  actionsEnabled: true,
  dialRoutes: [
    {
      route: { routeId: ROUTE_ID, contactId: null, e164: '+14015550187', version: 3, eligibility: 'usable' },
      enabled: true,
      advice: null,
      reasons: [],
    },
  ],
} as unknown as TodayScreenView;

const actions = { busy: () => false, dial: () => undefined } as unknown as TodayActions;

const noop = (): void => undefined;

afterEach(cleanup);

describe('the call brief', () => {
  it('opens with the announcement, above the failed-tries line and the judgments', () => {
    render(<Brief recording brief={brief()} enabled onResearchAgain={noop} researching={false} />);

    const announcement = screen.getByTestId('call-announcement');
    expect(screen.getByTestId('today-brief').firstElementChild).toBe(announcement);
    expect(announcement.textContent).toBe(`${CALL_ANNOUNCEMENT_LABEL}${CALL_ANNOUNCEMENT}`);
    expect(screen.getByTestId('call-announcement-text').textContent).toBe(
      'Hi, this is David from Callie. This call is being recorded and transcribed for my notes.',
    );
    // This brief has both of the things that used to be first.
    expect(screen.getByTestId('brief-failed')).not.toBeNull();
    expect(screen.getByTestId('brief-judgments')).not.toBeNull();
  });

  it('says it for a firm nobody has researched too, because it is not about the firm', () => {
    render(<Brief recording brief={null} enabled onResearchAgain={noop} researching={false} />);
    expect(screen.getByTestId('today-brief').firstElementChild).toBe(screen.getByTestId('call-announcement'));
    expect(screen.getByTestId('call-announcement-text').textContent).toBe(CALL_ANNOUNCEMENT);
    expect(screen.getByTestId('brief-absent')).not.toBeNull();
  });
  it.each([null, brief()])('does not claim recording for a brief without confirmed recording mode', value => {
    render(<Brief brief={value} enabled onResearchAgain={noop} researching={false} />);
    expect(screen.queryByTestId('call-announcement')).toBeNull();
    expect(screen.getByTestId('today-brief').textContent).not.toContain('recorded and transcribed');
  });
});

describe('the dial panel', () => {
  it('keeps the phone-app Call action without claiming recording or transcription', () => {
    render(<DialPanel state={state} view={view} actions={actions} />);

    expect(screen.queryByTestId('call-announcement')).toBeNull();
    // And the button it sits above is still there, with its number.
    expect(screen.getByTestId('dial').textContent).toBe('Call +14015550187');
  });
  it.each(['tel', 'unavailable', null])('does not announce recording with provider %s', provider => {
    const calling = { status: { view: provider === null ? null : { provider, cadence: null }, reload: noop }, call: {} } as unknown as DialCalling;
    render(<DialPanel state={state} view={view} actions={actions} calling={calling} />);
    expect(screen.queryByTestId('call-announcement')).toBeNull();
    expect(screen.getByTestId('dial-panel').textContent).not.toContain('recorded and transcribed');
    expect((screen.getByTestId('dial') as HTMLButtonElement).disabled).toBe(provider !== 'tel');
  });
});
