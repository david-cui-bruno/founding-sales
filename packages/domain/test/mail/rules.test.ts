import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_TOKEN_POLICY,
  decidePushToken,
  fixturePushTokens,
  grantCodeChallenge,
  grantCodeVerifier,
  localEnvelopeCipher,
  normalizeAddress,
  normalizeAddressList,
  normalizeMessageId,
  normalizeMessageIdList,
  normalizeMetadata,
  readGmailNotification,
  signGrantState,
  verifyGrantState,
  type PushTokenClaims,
} from '../../mail/index.ts';

/**
 * The parts of the mail lane that need no database and no network.
 *
 * Appendix G 27 lives here rather than in the webhook test, because the point of the
 * split in `pushToken.ts` is that the six claim checks are decidable without a key:
 * the signature is valid by construction and the refusal comes from the claims.
 */

const POLICY = {
  issuer: DEFAULT_PUSH_TOKEN_POLICY.issuer,
  audience: 'https://api.example.test/pubsub/gmail',
  serviceAccountEmail: 'fss-test-push@callie-fss.iam.gserviceaccount.test',
  clockSkewSeconds: 60,
  maximumAgeSeconds: 600,
};

const NOW = 1_800_000_000;

function claims(overrides: Partial<PushTokenClaims> = {}): PushTokenClaims {
  return {
    iss: POLICY.issuer,
    aud: POLICY.audience,
    email: POLICY.serviceAccountEmail,
    email_verified: true,
    iat: NOW - 10,
    exp: NOW + 3000,
    ...overrides,
  };
}

describe('the Pub/Sub push token (Appendix G 27)', () => {
  it('accepts a token whose seven checks all pass', () => {
    expect(decidePushToken(claims(), POLICY, NOW)).toEqual({ accepted: true });
  });

  it('refuses a valid Google signature with the wrong audience', () => {
    expect(decidePushToken(claims({ aud: 'https://api.example.test/pubsub/other' }), POLICY, NOW)).toEqual({
      accepted: false,
      refusal: 'audience_mismatch',
    });
    // A prefix is not the audience. This is the case an exact comparison exists for.
    expect(decidePushToken(claims({ aud: `${POLICY.audience}/extra` }), POLICY, NOW).accepted).toBe(false);
  });

  it('refuses a valid Google signature with the wrong service-account email', () => {
    expect(
      decidePushToken(claims({ email: 'someone-else@callie-fss.iam.gserviceaccount.test' }), POLICY, NOW),
    ).toEqual({ accepted: false, refusal: 'service_account_mismatch' });
  });

  it('compares the service-account address case-insensitively and the audience exactly', () => {
    expect(decidePushToken(claims({ email: POLICY.serviceAccountEmail.toUpperCase() }), POLICY, NOW).accepted).toBe(
      true,
    );
    expect(decidePushToken(claims({ aud: POLICY.audience.toUpperCase() }), POLICY, NOW).accepted).toBe(false);
  });

  it('refuses another issuer, an unverified address, an expired token and one from the future', () => {
    expect(decidePushToken(claims({ iss: 'https://accounts.example.test' }), POLICY, NOW).accepted).toBe(false);
    expect(decidePushToken(claims({ email_verified: false }), POLICY, NOW)).toEqual({
      accepted: false,
      refusal: 'email_unverified',
    });
    expect(decidePushToken(claims({ exp: NOW - 120 }), POLICY, NOW)).toEqual({
      accepted: false,
      refusal: 'expired',
    });
    expect(decidePushToken(claims({ iat: NOW + 600 }), POLICY, NOW)).toEqual({
      accepted: false,
      refusal: 'issued_in_future',
    });
  });

  it('refuses a token that is old but not expired', () => {
    expect(decidePushToken(claims({ iat: NOW - 5000, exp: NOW + 5000 }), POLICY, NOW)).toEqual({
      accepted: false,
      refusal: 'too_old',
    });
  });

  it('verifies a signature it made and refuses one made with another key', async () => {
    const tokens = fixturePushTokens();
    const subject = claims();
    expect(await tokens.verifier.verify(tokens.sign(subject))).toMatchObject({ aud: POLICY.audience });
    expect(await tokens.verifier.verify(tokens.signWithAnotherKey(subject))).toBeNull();
    expect(await tokens.verifier.verify('not.a.token')).toBeNull();
  });

  it('refuses an unsigned token however well formed', async () => {
    const tokens = fixturePushTokens();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims())).toString('base64url');
    expect(await tokens.verifier.verify(`${header}.${payload}.`)).toBeNull();
  });
});

describe('the Gmail notification body', () => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

  it('reads an address and a history id and nothing else', () => {
    const body = {
      message: {
        data: encode({ emailAddress: 'Sales.Alpha@Example.Test', historyId: 4321 }),
        messageId: '1122334455',
        publishTime: '2026-09-11T12:00:00.000Z',
      },
    };
    expect(readGmailNotification(body)).toEqual({
      emailAddress: 'sales.alpha@example.test',
      historyId: '4321',
      providerMessageId: '1122334455',
      publishedAt: '2026-09-11T12:00:00.000Z',
    });
  });

  it('accepts both spellings Pub/Sub uses for the message id', () => {
    const data = encode({ emailAddress: 'a@example.test', historyId: '7' });
    expect(readGmailNotification({ message: { data, message_id: '9' } })?.providerMessageId).toBe('9');
  });

  it('refuses anything it cannot read rather than guessing', () => {
    expect(readGmailNotification(null)).toBeNull();
    expect(readGmailNotification({})).toBeNull();
    expect(readGmailNotification({ message: { messageId: '1' } })).toBeNull();
    expect(readGmailNotification({ message: { data: 'not base64 json', messageId: '1' } })).toBeNull();
    expect(
      readGmailNotification({ message: { data: encode({ emailAddress: 'a@example.test' }), messageId: '1' } }),
    ).toBeNull();
    expect(
      readGmailNotification({
        message: { data: encode({ emailAddress: 'a@example.test', historyId: 'latest' }), messageId: '1' },
      }),
    ).toBeNull();
  });
});

describe('header normalization', () => {
  it('reduces a From header to one canonical address', () => {
    expect(normalizeAddress('Dana Example <Dana@Northwind.Example.Test>')).toBe('dana@northwind.example.test');
    expect(normalizeAddress('  plain@example.test ')).toBe('plain@example.test');
    expect(normalizeAddress('not an address')).toBeNull();
    expect(normalizeAddress(undefined)).toBeNull();
  });

  it('keeps a recipient list in order and without duplicates', () => {
    expect(normalizeAddressList('One <one@example.test>, two@example.test, One <ONE@example.test>')).toEqual([
      'one@example.test',
      'two@example.test',
    ]);
  });

  it('stores a Message-ID without its angle brackets', () => {
    expect(normalizeMessageId('<abc@mail.example.test>')).toBe('abc@mail.example.test');
    expect(normalizeMessageId('abc@mail.example.test')).toBe('abc@mail.example.test');
    expect(normalizeMessageId('<has space@example.test>')).toBeNull();
    expect(normalizeMessageIdList('<a@example.test> <b@example.test> <a@example.test>')).toEqual([
      'a@example.test',
      'b@example.test',
    ]);
  });

  it('folds In-Reply-To into the reference list, once', () => {
    const normalized = normalizeMetadata({
      id: 'm1',
      threadId: 't1',
      internalDateEpochMilliseconds: Date.parse('2026-09-10T14:00:00Z'),
      labelIds: ['INBOX'],
      headers: {
        From: 'Dana <dana@northwind.example.test>',
        To: 'sales@example.test',
        References: '<one@example.test>',
        'In-Reply-To': '<two@example.test>',
        Subject: 'Re: hello',
      },
      attachments: [],
      sizeEstimate: 10,
    });
    expect(normalized.referenceMessageIds).toEqual(['one@example.test', 'two@example.test']);
    expect(normalized.inReplyTo).toBe('two@example.test');
    expect(normalized.direction).toBe('incoming');
  });

  it('reads the direction from the SENT label rather than from the addresses', () => {
    const outgoing = normalizeMetadata({
      id: 'm2',
      threadId: 't1',
      internalDateEpochMilliseconds: Date.parse('2026-09-10T14:00:00Z'),
      labelIds: ['SENT'],
      headers: { From: 'sales@example.test', To: 'dana@northwind.example.test' },
      attachments: [],
      sizeEstimate: 10,
    });
    expect(outgoing.direction).toBe('outgoing');
  });
});

describe('the envelope cipher', () => {
  it('round-trips a secret and produces a different ciphertext each time', async () => {
    const cipher = localEnvelopeCipher('test-envelope');
    const secret = randomBytes(24).toString('base64url');
    const first = await cipher.encrypt(secret);
    const second = await cipher.encrypt(secret);
    expect(await cipher.decrypt(first)).toBe(secret);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.iv.length).toBe(12);
    expect(first.authTag.length).toBe(16);
    expect(first.keyId).toBe('test-envelope');
    // The plaintext is nowhere in the envelope.
    expect(first.ciphertext.toString('utf8')).not.toContain(secret);
  });

  it('refuses a ciphertext whose tag does not authenticate', async () => {
    const cipher = localEnvelopeCipher();
    const envelope = await cipher.encrypt('a secret value');
    const tampered = { ...envelope, ciphertext: Buffer.concat([envelope.ciphertext.subarray(1), Buffer.of(0)]) };
    await expect(cipher.decrypt(tampered)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('refuses an envelope wrapped under a key this process does not have', async () => {
    const cipher = localEnvelopeCipher('key-one');
    const envelope = await cipher.encrypt('a secret value');
    const other = localEnvelopeCipher('key-two');
    await expect(other.decrypt(envelope)).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
  });
});

describe('the Gmail grant state', () => {
  it('verifies its own state and refuses a forged, expired or altered one', () => {
    const key = randomBytes(32);
    const now = 1_800_000_000;
    const subject = {
      workspaceId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      expiresAtEpochSeconds: now + 600,
    };
    const state = signGrantState(key, subject);
    expect(verifyGrantState(key, state, now)).toEqual(subject);
    expect(verifyGrantState(randomBytes(32), state, now)).toBeNull();
    expect(verifyGrantState(key, state, now + 601)).toBeNull();
    expect(verifyGrantState(key, `${state}x`, now)).toBeNull();
    expect(verifyGrantState(key, 'not-a-state', now)).toBeNull();
  });

  it('derives a PKCE verifier from the state and never stores one', () => {
    const key = randomBytes(32);
    const verifier = grantCodeVerifier(key, 'some-state');
    expect(grantCodeVerifier(key, 'some-state')).toBe(verifier);
    expect(grantCodeVerifier(key, 'another-state')).not.toBe(verifier);
    expect(grantCodeChallenge(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
