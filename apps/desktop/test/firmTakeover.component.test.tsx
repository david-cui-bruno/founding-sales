// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FirmPageResponse } from '@fss/contracts';
import { FirmPage } from '../src/renderer/firms/FirmPage.tsx';
import { assigneeFirmPage } from './e2e/support/crmFixtures.ts';

/**
 * "I will handle this myself", and when it is offered
 * (P1-1 of the second review of PR 332).
 *
 * The control writes the one manual-mode origin an evidenced follow-up does not run
 * beside. It was offered only while the opportunity was *automated*, which hid it in the
 * state a person most needs it: manual on a prospect signal — or on a direct send they
 * chose to keep following up after — is exactly the state in which Callie is still
 * writing to this firm. It is hidden only where pressing it would change nothing: an
 * opportunity already taken over by hand, and a closed one.
 */

afterEach(cleanup);

type Page = Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>;

function pageWith(opportunity: Partial<NonNullable<Page['opportunity']>>): Page {
  const base = assigneeFirmPage() as Page;
  const existing = base.opportunity;
  if (existing === null) throw new Error('the fixture firm has no opportunity');
  return { ...base, opportunity: { ...existing, ...opportunity } };
}

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

const offered = (): boolean => screen.queryByTestId('take-over') !== null;

describe('the takeover control', () => {
  it('is offered while the opportunity is automated', () => {
    draw(pageWith({ status: 'open', controlMode: 'automated', controlModeOrigin: null }));
    expect(offered()).toBe(true);
  });

  it('is offered when manual on a prospect signal, which is when it matters', () => {
    for (const origin of ['human_reply', 'engaged_call'] as const) {
      cleanup();
      draw(pageWith({ status: 'open', controlMode: 'manual', controlModeOrigin: origin }));
      expect(offered(), origin).toBe(true);
    }
  });

  it('is offered when the person chose to keep following up after their own send', () => {
    draw(pageWith({ status: 'open', controlMode: 'manual', controlModeOrigin: 'direct_send_keep_automation' }));
    expect(offered()).toBe(true);
  });

  it('is not offered once the firm is already taken over by hand', () => {
    draw(pageWith({ status: 'open', controlMode: 'manual', controlModeOrigin: 'salesperson_command' }));
    expect(offered()).toBe(false);
  });

  it('is not offered on a closed opportunity', () => {
    draw(pageWith({ status: 'won', controlMode: 'automated', controlModeOrigin: null }));
    expect(offered()).toBe(false);
  });
});
