import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_TOKEN_POLICY,
  RECORDED_SEAM_ENCRYPTION_CONTEXT,
  RECORDED_SEAM_KEY_PREFIX,
  decidePushToken,
  envelopeCipher,
  fixturePushTokens,
  grantCodeChallenge,
  grantCodeVerifier,
  kmsDataKeyWrapper,
  localEnvelopeCipher,
  recordedGmailClient,
  recordedSentMessageId,
  recordedSeamDataKeyWrapper,
  type GmailSendRequest,
  type KmsTransport,
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

// The skew and the age bound are the shipped ones, so a test of either tests what the
// webhook runs with rather than a copy of it.
const POLICY = {
  ...DEFAULT_PUSH_TOKEN_POLICY,
  audience: 'https://api.example.test/pubsub/gmail',
  serviceAccountEmail: 'fss-test-push@callie-fss.iam.gserviceaccount.test',
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

  // Pub/Sub presents one token for the whole hour it lives. Production refused every
  // push past a token's eleventh minute while the bound was 600 s: 138 refusals in
  // three hours on 24 and 25 September 2026.
  it('accepts a Google push token for the whole of its hour', () => {
    expect(decidePushToken(claims({ iat: NOW - 1800, exp: NOW + 1800 }), POLICY, NOW)).toEqual({ accepted: true });
    expect(decidePushToken(claims({ iat: NOW - 3540, exp: NOW + 60 }), POLICY, NOW)).toEqual({ accepted: true });
  });

  it('refuses a token more than an hour old, whatever its exp says', () => {
    // The bound is the hour plus the skew, and not a second more.
    expect(decidePushToken(claims({ iat: NOW - 3660, exp: NOW + 3600 }), POLICY, NOW)).toEqual({ accepted: true });
    expect(decidePushToken(claims({ iat: NOW - 3661, exp: NOW + 3600 }), POLICY, NOW)).toEqual({
      accepted: false,
      refusal: 'too_old',
    });
  });

  it('names a token that is expired and too old expired', () => {
    expect(decidePushToken(claims({ iat: NOW - 7200, exp: NOW - 3600 }), POLICY, NOW)).toEqual({
      accepted: false,
      refusal: 'expired',
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

  /**
   * Lane g59: the recorded seam's wrapper is the production KMS wrapper with an
   * encryption context and a labelled key id. The trap is a wrapper that dropped the
   * context: every assertion about sharing would still pass, and a live process could
   * then unwrap a recorded token and the drill's IAM condition would never match.
   */
  it('on the recorded seam, binds every KMS call to the recorded context and labels the key id', async () => {
    const calls: { kind: string; keyId: string; context: unknown }[] = [];
    const transport: KmsTransport = {
      generateDataKey: async input => {
        calls.push({ kind: 'generate', keyId: input.KeyId, context: input.EncryptionContext });
        const plaintext = randomBytes(32);
        return await Promise.resolve({ Plaintext: plaintext, CiphertextBlob: Buffer.from(plaintext) });
      },
      decrypt: async input => {
        calls.push({ kind: 'decrypt', keyId: input.KeyId, context: input.EncryptionContext });
        return await Promise.resolve({ Plaintext: Buffer.from(input.CiphertextBlob) });
      },
    };
    const cipher = envelopeCipher(recordedSeamDataKeyWrapper({ keyId: 'alias/fss-rh-test-envelope', transport }));
    const envelope = await cipher.encrypt('a recorded token');
    expect(envelope.keyId).toBe(`${RECORDED_SEAM_KEY_PREFIX}alias/fss-rh-test-envelope`);
    expect(await cipher.decrypt(envelope)).toBe('a recorded token');
    expect(calls).toEqual([
      { kind: 'generate', keyId: 'alias/fss-rh-test-envelope', context: RECORDED_SEAM_ENCRYPTION_CONTEXT },
      { kind: 'decrypt', keyId: 'alias/fss-rh-test-envelope', context: RECORDED_SEAM_ENCRYPTION_CONTEXT },
    ]);
    // A live wrapper names the bare key, so it refuses the row before asking KMS.
    const live = envelopeCipher(kmsDataKeyWrapper({ keyId: 'alias/fss-rh-test-envelope', transport }));
    await expect(live.decrypt(envelope)).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
    expect(calls).toHaveLength(2);
  });
});

describe('the recorded Gmail mailbox, across processes (lane g59)', () => {
  const access = { accessToken: 'fixture-access', expiresAtEpochSeconds: 0 };
  const request = (rfcMessageId: string): GmailSendRequest => ({
    to: 'prospect@example.test',
    from: 'sales@example.test',
    subject: 'Hello',
    body: 'Hello',
    rfcMessageId,
  });

  it('reports what its Sent folder holds: delivered sends, never refused or lost ones', async () => {
    const accepting = recordedGmailClient({ emailAddress: 'sales@example.test', historyId: '1', messages: [] });
    await accepting.sendMessage(access, request('<a@example.test>'));
    const dropping = recordedGmailClient({
      emailAddress: 'sales@example.test',
      historyId: '1',
      messages: [],
      sendBehaviour: 'indeterminate_but_delivered',
    });
    await dropping.sendMessage(access, request('<b@example.test>'));
    const losing = recordedGmailClient({
      emailAddress: 'sales@example.test',
      historyId: '1',
      messages: [],
      sendBehaviour: 'indeterminate',
    });
    await losing.sendMessage(access, request('<c@example.test>'));
    expect(accepting.sentMessageIds).toEqual(['<a@example.test>']);
    expect(dropping.sentMessageIds).toEqual(['<b@example.test>']);
    expect(losing.sentMessageIds).toEqual([]);
  });

  it('a second client built from that recording finds the send, and one without it does not', async () => {
    const recorded = recordedGmailClient({
      emailAddress: 'sales@example.test',
      historyId: '1',
      messages: [],
      sentMessageIds: ['<b@example.test>'],
    });
    expect(await recorded.searchSentByMessageId(access, '<b@example.test>')).toMatchObject({ ok: true, found: { threadId: expect.any(String) } });
    const empty = recordedGmailClient({ emailAddress: 'sales@example.test', historyId: '1', messages: [] });
    expect(await empty.searchSentByMessageId(access, '<b@example.test>')).toEqual({ ok: true, found: null });
  });

  it('lists its Sent folder by window, with the metadata a delivered message carries (lane g73)', async () => {
    const sender = recordedGmailClient({ emailAddress: 'sales@example.test', historyId: '1', messages: [] });
    const sent = await sender.sendMessage(access, request('<d@example.test>'));
    expect(sent).toMatchObject({ ok: true, messageId: recordedSentMessageId('<d@example.test>') });
    const [delivered] = sender.sentMessages;
    expect(delivered).toMatchObject({
      id: recordedSentMessageId('<d@example.test>'),
      labelIds: ['SENT'],
      headers: { 'Message-ID': '<d@example.test>', To: 'prospect@example.test', Subject: 'Hello' },
    });

    // A second process built from that recording lists it, reads its metadata, and
    // finds it by Message-ID under the same Gmail id.
    const at = delivered?.internalDateEpochMilliseconds ?? 0;
    const reader = recordedGmailClient({
      emailAddress: 'sales@example.test',
      historyId: '1',
      messages: [],
      sentMessages: sender.sentMessages,
    });
    const seconds = Math.floor(at / 1000);
    const inside = await reader.listSentMessageIds(access, { afterEpochSeconds: seconds, beforeEpochSeconds: seconds + 1, maxResults: 500 });
    expect(inside).toEqual({ ok: true, messageIds: [delivered?.id], nextPageToken: null });
    const outside = await reader.listSentMessageIds(access, { afterEpochSeconds: seconds + 1, beforeEpochSeconds: seconds + 60, maxResults: 500 });
    expect(outside).toEqual({ ok: true, messageIds: [], nextPageToken: null });
    const metadata = await reader.getMetadata(access, delivered?.id ?? '', ['Message-ID', 'To']);
    expect(metadata?.headers).toEqual({ 'Message-ID': '<d@example.test>', To: 'prospect@example.test' });
    expect(await reader.searchSentByMessageId(access, '<d@example.test>')).toMatchObject({
      ok: true,
      found: { messageId: delivered?.id },
    });
    // The inbox listing is unchanged by a Sent folder: nothing else sees those ids.
    expect(await reader.listMessageIds(access, { afterEpochSeconds: 0, beforeEpochSeconds: seconds + 60, maxResults: 500 })).toEqual({
      ok: true,
      messageIds: [],
      nextPageToken: null,
    });
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
