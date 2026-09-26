import { randomUUID } from 'node:crypto';
import type { DesktopState, MailboxState } from '../../../src/shared/contract.ts';

/**
 * The session's fixtures, for the one harness (`appServer.ts`): signed out, signed in
 * as a salesperson with one cached card, and the Mailbox row before and after a grant.
 */

export const EXAMPLE_WORKSPACE = '11111111-1111-4111-8111-111111111111';
export const EXAMPLE_USER = '22222222-2222-4222-8222-222222222222';
export const EXAMPLE_DEVICE = '33333333-3333-4333-8333-333333333333';

export function signedOutState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    screen: 'sign_in',
    clientVersion: '1.4.0',
    supportedClientVersions: { minimum: '1.2.0', maximum: '1.4.0' },
    device: null,
    online: true,
    stale: false,
    asOf: null,
    mayMutate: false,
    notice: null,
    today: null,
    rememberedWorkspace: null,
    ...overrides,
  };
}

export function signedInState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    ...signedOutState(),
    screen: 'today',
    device: {
      deviceId: EXAMPLE_DEVICE,
      deviceLabel: "David's MacBook",
      workspaceId: EXAMPLE_WORKSPACE,
      role: 'salesperson',
      registeredAt: '2026-09-21T09:00:00.000Z',
    },
    mayMutate: true,
    asOf: '2026-09-21T09:05:00.000Z',
    today: {
      workspaceId: EXAMPLE_WORKSPACE,
      snapshotDate: '2026-09-21',
      businessTimeZone: 'America/New_York',
      cards: [
        {
          firmId: randomUUID(),
          firmName: 'Ash & Partners',
          lane: 'reply',
          dueAt: '2026-09-21T13:00:00.000Z',
          counts: { replies: 1, emailsDue: 0, callsDue: 0 },
        },
      ],
    },
    ...overrides,
  };
}

export const EXAMPLE_MAILBOX_ADDRESS = 'sales@example.test';

/** The Mailbox row before anything is connected: what `/gmail/status` says for a new user. */
export function notConnectedMailbox(overrides: Partial<MailboxState> = {}): MailboxState {
  return { status: { connected: false, mailbox: null }, connecting: false, mayConnect: true, notice: null, ...overrides };
}

/** What the main process answers once the grant has landed and the baseline has started. */
export function connectedMailbox(overrides: Partial<MailboxState> = {}): MailboxState {
  return {
    status: {
      connected: true,
      mailbox: { emailAddress: EXAMPLE_MAILBOX_ADDRESS, status: 'connected', syncState: 'baseline_pending' },
    },
    connecting: false,
    mayConnect: true,
    notice: null,
    ...overrides,
  };
}
