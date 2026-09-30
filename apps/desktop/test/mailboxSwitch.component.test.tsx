// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FirmPageResponse } from '@fss/contracts';
import { reasonSentence } from '@fss/contracts';
import { FirmPage } from '../src/renderer/firms/FirmPage.tsx';
import { MailboxSection } from '../src/renderer/settings/MailboxSection.tsx';
import { mailboxStateSchema, type MailboxState } from '../src/shared/contract.ts';
import { buildMailboxSection, switchTargetIssue } from '../src/renderer/viewModel.ts';
import { noticeSentence } from '../src/renderer/todayView.ts';
import { assigneeFirmPage } from './e2e/support/crmFixtures.ts';

/**
 * Settings › Mailbox and the switch confirmation (call-to-booking A3), and the two places
 * a hold used to print its code.
 */

afterEach(cleanup);

const OLD = 'callie@example.test';

function state(overrides: Record<string, unknown> = {}, mailbox: Record<string, unknown> = {}): MailboxState {
  return mailboxStateSchema.parse({
    status: {
      connected: true,
      mailbox: {
        emailAddress: OLD,
        status: 'connected',
        syncState: 'ready',
        lastSyncedAt: '2026-09-30T12:00:00.000Z',
        baseline: null,
        ...mailbox,
      },
      lastGrantRefusal: null,
    },
    switchingTo: null,
    connecting: false,
    mayConnect: true,
    notice: null,
    ...overrides,
  });
}

function draw(mailbox: MailboxState | null, onSwitch: (to: string) => void = () => undefined, waiting = false): void {
  render(<MailboxSection mailbox={mailbox} waiting={waiting} available onSwitch={onSwitch} />);
}

describe('Settings › Mailbox', () => {
  it('shows the address, the sync state and when it last synced', () => {
    draw(state());
    expect(screen.getByTestId('mailbox-address').textContent).toBe(OLD);
    expect(screen.getByTestId('mailbox-state').textContent).toBe('Connected · up to date');
    expect(screen.getByTestId('mailbox-synced').textContent).toMatch(/^Last synced /u);
    expect(screen.queryByTestId('mailbox-baseline')).toBeNull();
  });

  it('shows baseline progress while the mailbox is baseline_pending', () => {
    draw(state({}, { syncState: 'baseline_pending', lastSyncedAt: null, baseline: { messagesSeen: 140, completed: false } }));
    expect(screen.getByTestId('mailbox-baseline').textContent).toBe('Reading the last 30 days: 140 messages so far');
    expect(screen.getByTestId('mailbox-synced').textContent).toBe('Not synced yet');
  });

  it('says "Reading the last 30 days…" before any message has been counted', () => {
    draw(state({}, { syncState: 'baseline_pending', baseline: null }));
    expect(screen.getByTestId('mailbox-baseline').textContent).toBe('Reading the last 30 days…');
  });

  it('offers nothing to press before the status has been read, or while the Mac may not start a grant', () => {
    draw(null);
    expect(screen.queryByTestId('mailbox-switch')).toBeNull();
    cleanup();
    draw(state({ mayConnect: false }));
    expect(screen.queryByTestId('mailbox-switch')).toBeNull();
  });

  it('waits, naming the address, instead of offering a second switch', () => {
    draw(state({ connecting: true, switchingTo: 'david@example.test' }));
    expect(screen.queryByTestId('mailbox-switch')).toBeNull();
    expect(screen.getByTestId('mailbox-waiting').textContent).toBe('Waiting for your browser… (david@example.test)');
  });

  it('shows a refusal of this attempt, and the last refusal when it is another', () => {
    draw(state({ notice: 'mailbox_switch_address_mismatch' }));
    expect(screen.getByTestId('mailbox-switch-notice').textContent).toBe(reasonSentence('mailbox_switch_address_mismatch'));
    cleanup();
    const withRefusal = mailboxStateSchema.parse({
      ...state(),
      status: { ...state().status, lastGrantRefusal: { reason: 'mailbox_switch_wrong_domain', at: '2026-09-30T12:00:00.000Z' } },
    });
    draw(withRefusal);
    expect(screen.getByTestId('mailbox-last-refusal').textContent).toContain(reasonSentence('mailbox_switch_wrong_domain'));
  });

  it('puts the old address in the sentence when Google never confirmed', () => {
    draw(state({ notice: 'mailbox_switch_timed_out' }));
    expect(screen.getByTestId('mailbox-switch-notice').textContent).toBe(
      `Google didn’t confirm the switch. Your mailbox is still ${OLD}.`,
    );
  });

  it('shows the new address with "Reading the last 30 days…" after a successful switch', () => {
    const view = buildMailboxSection(
      state({}, { emailAddress: 'david@example.test', syncState: 'baseline_pending', baseline: null }),
    );
    expect(view.address).toBe('david@example.test');
    expect(view.baselineLine).toBe('Reading the last 30 days…');
  });
});

describe('the switch confirmation', () => {
  async function open(onSwitch: (to: string) => void = () => undefined): Promise<void> {
    draw(state(), onSwitch);
    await userEvent.click(screen.getByTestId('mailbox-switch'));
  }

  it('names from and to, what carries over, and what happens next', async () => {
    await open();
    const dialog = screen.getByRole('dialog', { name: 'Switch the sales mailbox' });
    expect(within(dialog).getByTestId('switch-route').textContent).toBe(`From ${OLD} to david@usecallie.com`);
    const carries = within(dialog).getByTestId('switch-carries').textContent ?? '';
    for (const item of ['Conversation history', 'suppression list', 'Follow-up permissions', 'Send history']) {
      expect(carries).toContain(item);
    }
    const next = within(dialog).getByTestId('switch-next').textContent ?? '';
    expect(next).toContain('Google asks you to choose the account');
    expect(next).toContain('last 30 days');
    expect(next).toContain('Automated sending stays paused');
  });

  it('defaults the address to david@usecallie.com and Continue sends it', async () => {
    const onSwitch = vi.fn();
    await open(onSwitch);
    expect((screen.getByTestId('switch-target') as HTMLInputElement).value).toBe('david@usecallie.com');
    await userEvent.click(screen.getByTestId('switch-continue'));
    expect(onSwitch).toHaveBeenCalledWith('david@usecallie.com');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refuses an address that is not an e-mail, and the address already connected', async () => {
    const onSwitch = vi.fn();
    await open(onSwitch);
    const field = screen.getByTestId('switch-target');
    await userEvent.clear(field);
    await userEvent.type(field, 'not an address');
    expect(screen.getByTestId('switch-target-issue').textContent).toBe('Enter a valid e-mail address.');
    expect((screen.getByTestId('switch-continue') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(field);
    await userEvent.type(field, OLD.toUpperCase());
    expect(screen.getByTestId('switch-target-issue').textContent).toBe(reasonSentence('mailbox_switch_same_address'));
    expect((screen.getByTestId('switch-continue') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId('switch-continue'));
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('Cancel and Escape close it without switching', async () => {
    const onSwitch = vi.fn();
    await open(onSwitch);
    await userEvent.click(screen.getByTestId('switch-cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByTestId('mailbox-switch'));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('validates as switchTargetIssue does', () => {
    expect(switchTargetIssue('a@b.co', null)).toBeNull();
    expect(switchTargetIssue('  ', null)).toBe('Enter a valid e-mail address.');
    expect(switchTargetIssue('a@b', null)).toBe('Enter a valid e-mail address.');
  });
});

describe('the places that printed a code now print a sentence', () => {
  it('draws a firm’s hold as its sentence, not its code', () => {
    const base = assigneeFirmPage() as Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>;
    const page = {
      ...base,
      holds: [
        {
          id: '99999999-9999-4999-8999-999999999999',
          reasonCode: 'cold_outreach_mailbox_required' as const,
          blockedActionKinds: ['email_send'],
          startedAt: '2026-09-30T12:00:00.000Z',
          recoveryAction: null,
        },
      ],
    };
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
    const text = screen.getByTestId('hold-reason').textContent ?? '';
    expect(text).toBe(reasonSentence('cold_outreach_mailbox_required'));
    expect(text).not.toContain('cold_outreach');
  });

  it('names the enrollment on a firm hold, and shows no line for a hold with none (R2)', () => {
    const base = assigneeFirmPage() as Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>;
    const page = {
      ...base,
      holds: [
        {
          id: '99999999-9999-4999-8999-999999999999',
          reasonCode: 'follow_up_expired' as const,
          blockedActionKinds: ['email_send'],
          startedAt: '2026-09-30T12:00:00.000Z',
          recoveryAction: null,
          enrollment: { id: '33333333-3333-4333-8333-333333333333', sequenceName: 'Spring follow-up', stepNumber: 2 },
        },
        {
          id: '88888888-8888-4888-8888-888888888888',
          reasonCode: 'scoped_pause' as const,
          blockedActionKinds: ['email_send'],
          startedAt: '2026-09-30T13:00:00.000Z',
          recoveryAction: null,
          enrollment: null,
        },
      ],
    };
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
    const lines = screen.getAllByTestId('hold-enrollment').map(node => node.textContent);
    expect(lines).toEqual(['Sequence: Spring follow-up, step 2']);
    expect(screen.getAllByTestId('firm-hold')).toHaveLength(2);
  });

  it('gives Today’s fallback a sentence for a code it has no table entry for', () => {
    expect(noticeSentence('coverage_incomplete')).toBe(reasonSentence('coverage_incomplete'));
    expect(noticeSentence('something_new')).toContain('(something_new)');
  });
});
