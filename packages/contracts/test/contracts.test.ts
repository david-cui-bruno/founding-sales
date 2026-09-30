import { describe, expect, it } from 'vitest';
import {
  BLOCKED_ACTION_KINDS,
  CALL_ANNOUNCEMENT,
  CALL_ANNOUNCEMENT_LABEL,
  HOLD_REASON_CODES,
  activeHoldSchema,
  callingIdentitySchema,
  clientCompatibility,
  clientVersionRangeSchema,
  commandReceiptSchema,
  compareVersions,
  deviceSchema,
  heartbeatSchema,
  isRecoverableHoldReason,
  jobSchema,
  mayMutate,
  suppressionEventSchema,
  workspaceSchema,
} from '../src/index.ts';

const NOW = '2026-09-19T12:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);

describe('the closed reason-code set', () => {
  it('has no duplicates', () => {
    expect(new Set(HOLD_REASON_CODES).size).toBe(HOLD_REASON_CODES.length);
  });

  it('marks the holds a salesperson must not be able to clear as unrecoverable', () => {
    for (const code of [
      'firm_suppressed',
      'handle_suppressed',
      'manual_suppression_review',
      'opportunity_manual',
      'posture_missing',
      'posture_overlapping',
      'posture_overdue',
      'restore_in_progress',
      'send_unknown_reconciling',
    ] as const) {
      expect(isRecoverableHoldReason(code), code).toBe(false);
    }
  });

  it('exposes a control for the holds that have one', () => {
    for (const code of ['mailbox_disconnected', 'uncertain_reply', 'ambiguous_match', 'long_hold_review'] as const) {
      expect(isRecoverableHoldReason(code), code).toBe(true);
    }
  });
});

describe('foundation row schemas', () => {
  it('accepts a workspace row and refuses an unknown field', () => {
    const row = {
      id: ID,
      slug: 'callie',
      displayName: 'Callie',
      businessTimeZone: 'America/New_York',
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(workspaceSchema.parse(row)).toEqual(row);
    expect(workspaceSchema.safeParse({ ...row, surprise: 1 }).success).toBe(false);
  });

  it('refuses a device row that carries anything but a hash', () => {
    const base = {
      id: ID,
      workspaceId: OTHER_ID,
      userId: OTHER_ID,
      deviceLabel: "David's MacBook",
      secretHash: HASH,
      credentialGeneration: 1,
      clientVersion: '1.0.0',
      status: 'active' as const,
      registeredAt: NOW,
      lastSeenAt: null,
      revokedAt: null,
    };
    expect(deviceSchema.parse(base).secretHash).toBe(HASH);
    expect(deviceSchema.safeParse({ ...base, secretHash: 'a-plaintext-secret' }).success).toBe(false);
  });

  it('refuses an enabled shared calling identity', () => {
    const base = {
      id: ID,
      workspaceId: OTHER_ID,
      ownerUserId: null,
      e164: '+14015550123',
      verificationStatus: 'verified' as const,
      enabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(callingIdentitySchema.safeParse(base).success).toBe(true);
    expect(callingIdentitySchema.safeParse({ ...base, enabled: true }).success).toBe(false);
    expect(
      callingIdentitySchema.safeParse({ ...base, ownerUserId: OTHER_ID, enabled: true }).success,
    ).toBe(true);
    expect(
      callingIdentitySchema.safeParse({
        ...base,
        ownerUserId: OTHER_ID,
        enabled: true,
        verificationStatus: 'unverified',
      }).success,
    ).toBe(false);
  });

  it('refuses a hold that blocks nothing, and a workspace hold with a scope key', () => {
    const base = {
      id: ID,
      workspaceId: OTHER_ID,
      scopeKind: 'firm' as const,
      scopeKey: 'firm-1',
      reasonCode: 'uncertain_reply' as const,
      blockedActionKinds: [...BLOCKED_ACTION_KINDS],
      sourceEventKind: 'message',
      sourceEventId: 'message-1',
      ownerUserId: null,
      startedAt: NOW,
      releasedAt: null,
      recoveryAction: 'confirm_reply' as const,
    };
    expect(activeHoldSchema.safeParse(base).success).toBe(true);
    expect(activeHoldSchema.safeParse({ ...base, blockedActionKinds: [] }).success).toBe(false);
    expect(activeHoldSchema.safeParse({ ...base, scopeKind: 'workspace' }).success).toBe(false);
    expect(
      activeHoldSchema.safeParse({ ...base, scopeKind: 'workspace', scopeKey: null }).success,
    ).toBe(true);
  });

  it('refuses a running job without a lease and a leased job that is not running', () => {
    const base = {
      id: ID,
      workspaceId: OTHER_ID,
      kind: 'mail.sync',
      payload: { mailbox: 'mailbox-1' },
      idempotencyKey: 'mail-sync:mailbox-1',
      state: 'queued' as const,
      runAt: NOW,
      notBefore: NOW,
      attemptCount: 0,
      maxAttempts: 10,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorDetail: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(jobSchema.safeParse(base).success).toBe(true);
    expect(jobSchema.safeParse({ ...base, state: 'running' }).success).toBe(false);
    expect(
      jobSchema.safeParse({ ...base, leaseOwner: 'worker-1', leaseExpiresAt: NOW }).success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({ ...base, state: 'running', leaseOwner: 'worker-1', leaseExpiresAt: NOW }).success,
    ).toBe(true);
  });

  it('keeps a mailbox heartbeat workspace-scoped and a service heartbeat not', () => {
    const base = {
      id: ID,
      workspaceId: null,
      component: 'api' as const,
      instanceKey: 'api-1',
      observedAt: NOW,
      detail: {},
    };
    expect(heartbeatSchema.safeParse(base).success).toBe(true);
    expect(heartbeatSchema.safeParse({ ...base, component: 'mailbox' }).success).toBe(false);
    expect(
      heartbeatSchema.safeParse({ ...base, component: 'mailbox', workspaceId: OTHER_ID }).success,
    ).toBe(true);
  });

  it('accepts a suppression event and a command receipt in their stored shapes', () => {
    expect(
      suppressionEventSchema.safeParse({
        workspaceId: ID,
        eventId: 'event-1',
        scope: 'handle',
        canonicalKey: 'someone@example.test',
        canonicalizerVersion: 'v1',
        source: 'prospect_opt_out',
        actorUserId: null,
        commandId: null,
        recordedAt: NOW,
        supersedesEventId: null,
        supersessionReason: null,
      }).success,
    ).toBe(true);

    expect(
      commandReceiptSchema.safeParse({
        workspaceId: ID,
        deviceId: OTHER_ID,
        commandId: 'command-with spaces',
        commandKind: 'firm.assign',
        payloadHash: HASH,
        resultStatus: 'accepted',
        result: null,
        createdAt: NOW,
      }).success,
    ).toBe(false);
  });
});

describe('the supported client-version range', () => {
  const range = clientVersionRangeSchema.parse({ minimum: '1.2.0', maximum: '1.4.3' });

  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
  });

  it('lets a supported client mutate and stops everything else', () => {
    expect(clientCompatibility(range, '1.3.0')).toEqual({ kind: 'supported', version: '1.3.0' });
    expect(mayMutate(range, '1.3.0')).toBe(true);

    expect(clientCompatibility(range, '1.1.9')).toEqual({
      kind: 'upgrade_required',
      version: '1.1.9',
      minimum: '1.2.0',
    });
    expect(mayMutate(range, '1.1.9')).toBe(false);

    expect(clientCompatibility(range, '2.0.0')).toEqual({
      kind: 'api_behind_client',
      version: '2.0.0',
      maximum: '1.4.3',
    });
    expect(mayMutate(range, '2.0.0')).toBe(false);
  });

  it('fails closed on a version it cannot read', () => {
    for (const announced of ['', 'latest', '1.2', '1.2.0-beta', '01.2.0']) {
      expect(clientCompatibility(range, announced), announced).toEqual({ kind: 'unreadable_version' });
      expect(mayMutate(range, announced), announced).toBe(false);
    }
  });

  it('refuses a range whose minimum is above its maximum', () => {
    expect(clientVersionRangeSchema.safeParse({ minimum: '2.0.0', maximum: '1.0.0' }).success).toBe(false);
  });
});

describe('the announcement said when a call connects', () => {
  it('is exactly the sentence David settled, to the character', () => {
    // Not a paraphrase and not a template. It is what a stranger is told about being
    // recorded, so it is asserted whole rather than matched loosely, and a change to it
    // is a change somebody has to make here on purpose.
    expect(CALL_ANNOUNCEMENT).toBe(
      'Hi, this is David from Callie. This call is being recorded and transcribed for my notes.',
    );
    expect(CALL_ANNOUNCEMENT_LABEL).toBe('Say when they answer');
  });

  it('is one line of plain text, with nothing in it to interpolate', () => {
    // A constant today and a workspace setting after the migration that rewrites
    // `workspace_settings_key_known`; whichever it is, it is a sentence and not a format
    // string, and the renderer shows it as a React child.
    expect(CALL_ANNOUNCEMENT).not.toMatch(/[\r\n]/u);
    expect(CALL_ANNOUNCEMENT).not.toContain('{');
    expect(CALL_ANNOUNCEMENT).not.toContain('$');
  });
});

describe('the call-session refusal sentences (slice C1)', () => {
  it('has a sentence for every call-session code and for W’s retired attempt limit, never the code', async () => {
    const { CALL_SESSION_REFUSAL_CODES, callSessionRefusalSentence } = await import('../src/callSessions.ts');
    for (const code of [...CALL_SESSION_REFUSAL_CODES, 'call_attempt_limit', 'reservation_closed']) {
      const sentence = callSessionRefusalSentence(code);
      expect(sentence, code).toMatch(/\.$/u);
      expect(sentence).not.toContain(code);
    }
    expect(callSessionRefusalSentence('telephony_budget_exhausted')).toBe('Calling paused: today’s calling budget is used.');
    expect(callSessionRefusalSentence('reservation_closed')).toBe("The call couldn't be authorised because today's calling budget changed. Try again.");
    expect(callSessionRefusalSentence('firm_suppressed')).toBeNull();
  });

  it('renders the voicemail script with its four values', async () => {
    const { DEFAULT_VOICEMAIL_SCRIPT, renderVoicemailScript, firstNameOf } = await import('../src/callSessions.ts');
    expect(
      renderVoicemailScript(DEFAULT_VOICEMAIL_SCRIPT, {
        contactFirstName: firstNameOf('Dana Q. Example'),
        firmName: 'Northwind Test Holdings',
        callerName: 'Sam Example',
        callbackNumber: '+14015550100',
      }),
    ).toBe(
      "Hi Dana, this is Sam Example from Callie. I'm calling about how Northwind Test Holdings handles maintenance requests after hours. I'll try you again, or you can reach me at +14015550100. Thanks.",
    );
    expect(renderVoicemailScript('Hi {contactFirstName}.', { contactFirstName: null, firmName: '', callerName: '', callbackNumber: null })).toBe(
      'Hi there.',
    );
  });
});
