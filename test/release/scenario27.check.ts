import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_TOKEN_POLICY,
  PUSH_TOKEN_REFUSALS,
  decidePushToken,
  fixturePushTokens,
  type PushTokenPolicy,
} from '@fss/domain/mail';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 27: "Pub/Sub token with valid Google signature but wrong audience or
 * service-account email is refused."
 *
 * 4.1: "The webhook validates signature, issuer, exact audience, service-account email,
 * `email_verified`, expiration, and issued-at bounds." Seven checks, and the scenario is
 * about the six that are not the signature — because a token whose signature is invalid
 * tells you nothing about whether the claim checks work.
 *
 * ## The vacuous-pass trap
 *
 * A refusal caused by an invalid signature would satisfy a careless reading of this
 * scenario while leaving every claim check untested, and a policy comparison that used
 * `startsWith` rather than equality would pass any test whose wrong audience did not
 * happen to be a prefix of the right one.
 *
 * Closed by signing a genuinely valid token with the fixture key pair — so the signature
 * is correct by construction — and then asserting the refusal *names* the audience or the
 * service account. The near-miss cases are the point: an audience that is a prefix of the
 * configured one, and a service account differing only in case, which is the same address
 * and must be accepted.
 */

const POLICY: PushTokenPolicy = {
  ...DEFAULT_PUSH_TOKEN_POLICY,
  audience: 'https://api.example.test/integrations/gmail/push',
  serviceAccountEmail: 'fss-push@example.iam.gserviceaccount.test',
};

const NOW_SECONDS = 1_790_000_000;

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: POLICY.audience,
    email: POLICY.serviceAccountEmail,
    email_verified: true,
    exp: NOW_SECONDS + 600,
    iat: NOW_SECONDS - 10,
    ...overrides,
  };
}

describe('Appendix G 27: a valid Google signature is not an accepted notification', () => {
  mustCover(27, ['audience_mismatch', 'service_account_mismatch', 'decidePushToken']);

  it('accepts a correct token, so the refusals below are not free', () => {
    expect(decidePushToken(claims(), POLICY, NOW_SECONDS)).toEqual({ accepted: true });
  });

  it('verifies a genuinely signed token, so nothing here turns on a broken signature', async () => {
    const fixture = fixturePushTokens();
    const token = fixture.sign(claims());
    const verified = await fixture.verifier.verify(token);
    expect(verified).not.toBeNull();
    // Signature good, claims good: accepted. Signature good, audience wrong: refused.
    expect(decidePushToken(verified!, POLICY, NOW_SECONDS)).toEqual({ accepted: true });
    const wrongAudience = await fixture.verifier.verify(
      fixture.sign(claims({ aud: 'https://api.example.test/somewhere/else' })),
    );
    expect(decidePushToken(wrongAudience!, POLICY, NOW_SECONDS)).toEqual({
      accepted: false,
      refusal: 'audience_mismatch',
    });
  });

  it('refuses an audience that merely starts with the configured one', () => {
    expect(decidePushToken(claims({ aud: `${POLICY.audience}/extra` }), POLICY, NOW_SECONDS)).toEqual({
      accepted: false,
      refusal: 'audience_mismatch',
    });
    expect(decidePushToken(claims({ aud: POLICY.audience.slice(0, -5) }), POLICY, NOW_SECONDS)).toEqual({
      accepted: false,
      refusal: 'audience_mismatch',
    });
  });

  it('refuses another service account, and accepts the same one in a different case', () => {
    expect(
      decidePushToken(claims({ email: 'someone-else@example.iam.gserviceaccount.test' }), POLICY, NOW_SECONDS),
    ).toEqual({ accepted: false, refusal: 'service_account_mismatch' });
    // Google lower-cases addresses, so a differing case is the same account and must be
    // accepted — a comparison that refused it would reject real traffic.
    expect(
      decidePushToken(claims({ email: POLICY.serviceAccountEmail.toUpperCase() }), POLICY, NOW_SECONDS),
    ).toEqual({ accepted: true });
  });

  it('refuses the other four claim failures by name', () => {
    expect(decidePushToken(claims({ iss: 'https://accounts.example.test' }), POLICY, NOW_SECONDS)).toEqual({
      accepted: false,
      refusal: 'issuer_mismatch',
    });
    expect(decidePushToken(claims({ email_verified: false }), POLICY, NOW_SECONDS)).toEqual({
      accepted: false,
      refusal: 'email_unverified',
    });
    expect(decidePushToken(claims({ exp: NOW_SECONDS - 3600 }), POLICY, NOW_SECONDS)).toEqual({
      accepted: false,
      refusal: 'expired',
    });
    expect(decidePushToken(claims({ iat: NOW_SECONDS + 3600 }), POLICY, NOW_SECONDS)).toEqual({
      accepted: false,
      refusal: 'issued_in_future',
    });
    expect(decidePushToken(claims({ iat: NOW_SECONDS - 100_000 }), POLICY, NOW_SECONDS)).toEqual({
      accepted: false,
      refusal: 'too_old',
    });
  });

  it('has a refusal for every check 4.1 lists, and no more', () => {
    expect([...PUSH_TOKEN_REFUSALS].sort()).toEqual(
      [
        'audience_mismatch',
        'email_unverified',
        'expired',
        'issued_in_future',
        'issuer_mismatch',
        'service_account_mismatch',
        'signature_invalid',
        'too_old',
      ].sort(),
    );
  });
});
