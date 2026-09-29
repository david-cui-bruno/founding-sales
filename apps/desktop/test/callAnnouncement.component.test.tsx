// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CALL_ANNOUNCEMENT, CALL_ANNOUNCEMENT_LABEL, type CallBriefDto } from '@fss/contracts';
import { Brief } from '../src/renderer/research/Brief.tsx';
import { DialPanel } from '../src/renderer/today/Lanes.tsx';
import type { TodayState } from '../src/renderer/todayContract.ts';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayScreenView } from '../src/renderer/todayView.ts';

/**
 * The announcement, first on both screens a call is started from (29 September 2026).
 *
 * The call is recorded and transcribed, and the person answering is told so before
 * anything else is said. So the requirement is not that the sentence is *somewhere* on
 * the card — it is that it is the **first** thing on the brief and the first thing in the
 * dial panel, because a line further down is a line somebody reads after they have
 * already spoken.
 *
 * Both places are asserted by position, not by presence: the first element of the brief
 * and of the panel, with the exact sentence from `@fss/contracts`. It is a constant there
 * today rather than a workspace setting — `workspace_settings` pins its keys with a
 * database CHECK, so a key is a migration — and when it becomes a setting these two
 * assertions are what stop the default from quietly changing with it.
 *
 * No real firm, person or number appears; `example.test` is reserved by RFC 6761 and the
 * number is in the NANP 555-01XX block.
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

/** The text of the first element of `container`, whatever that element is. */
const firstLine = (node: HTMLElement): string => node.firstElementChild?.textContent ?? '';

afterEach(cleanup);

describe('the call brief', () => {
  it('opens with the announcement, above the failed-tries line and the judgments', () => {
    render(<Brief brief={brief()} enabled onResearchAgain={noop} researching={false} />);

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
    render(<Brief brief={null} enabled onResearchAgain={noop} researching={false} />);
    expect(screen.getByTestId('today-brief').firstElementChild).toBe(screen.getByTestId('call-announcement'));
    expect(screen.getByTestId('call-announcement-text').textContent).toBe(CALL_ANNOUNCEMENT);
    expect(screen.getByTestId('brief-absent')).not.toBeNull();
  });
});

describe('the dial panel', () => {
  it('opens with the announcement, above the Call button', () => {
    render(<DialPanel state={state} view={view} actions={actions} />);

    const panel = screen.getByTestId('dial-panel');
    expect(panel.firstElementChild).toBe(screen.getByTestId('call-announcement'));
    expect(firstLine(panel)).toBe(`${CALL_ANNOUNCEMENT_LABEL}${CALL_ANNOUNCEMENT}`);
    // And the button it sits above is still there, with its number.
    expect(screen.getByTestId('dial').textContent).toBe('Call +14015550187');
  });
});
