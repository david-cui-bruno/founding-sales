/**
 * Suppression canonicalisation (specification 10.2).
 *
 * Ported from `cloud/lambdas/delegated-worker/src/v1/suppression.ts` and
 * `src/main/domain/source/contactNormalization.ts`, with the same two rules and the
 * same refusals:
 *
 *   * a phone becomes E.164 under the United States default region; an explicit
 *     international number must already be canonical E.164, and an ambiguous digit
 *     count is refused rather than guessed at;
 *   * an address is NFKC-normalised, trimmed and lower-cased, and validated; anything
 *     the validator refuses is refused here rather than stored in whatever shape it
 *     arrived in.
 *
 * One handle has one spelling in the suppression set, whichever path wrote it. Every
 * event records `CANONICALIZER_VERSION`, so a later change to these rules is a new
 * version rather than a silent reinterpretation of stored keys: Appendix G 21
 * requires an unsupported canonicalizer change to be refused, and it can only be
 * recognised because the version is stored.
 */

/** Stored on every suppression event. Bump when any rule below changes. */
export const CANONICALIZER_VERSION = 'e164-lower.1';

/** Version one intentionally uses the United States as the only default for non-E.164 phones. */
export const DEFAULT_PHONE_REGION = 'US' as const;

export type CanonicalChannel = 'phone' | 'email';

export interface CanonicalHandle {
  readonly channel: CanonicalChannel;
  readonly value: string;
  readonly canonicalizerVersion: string;
}

export type CanonicalizationRefusal =
  | 'empty'
  | 'phone_not_canonical_international'
  | 'phone_invalid'
  | 'phone_ambiguous'
  | 'email_invalid';

export type CanonicalizationResult =
  | { readonly ok: true; readonly handle: CanonicalHandle }
  | { readonly ok: false; readonly refusal: CanonicalizationRefusal };

const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A phone number as E.164, or the reason it is not one. */
export function canonicalizePhone(value: string): CanonicalizationResult {
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length === 0) return { ok: false, refusal: 'empty' };

  if (normalized.startsWith('+')) {
    if (/^\+[\d\s().-]+$/.test(normalized)) {
      const digits = normalized.slice(1).replace(/\D/g, '');
      if (/^[1-9]\d{7,14}$/.test(digits)) {
        return { ok: true, handle: { channel: 'phone', value: `+${digits}`, canonicalizerVersion: CANONICALIZER_VERSION } };
      }
    }
    return { ok: false, refusal: 'phone_not_canonical_international' };
  }

  if (!/^[\d\s().-]+$/.test(normalized)) return { ok: false, refusal: 'phone_invalid' };
  const digits = normalized.replace(/\D/g, '');
  if (digits.length === 10) {
    return { ok: true, handle: { channel: 'phone', value: `+1${digits}`, canonicalizerVersion: CANONICALIZER_VERSION } };
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return { ok: true, handle: { channel: 'phone', value: `+${digits}`, canonicalizerVersion: CANONICALIZER_VERSION } };
  }
  return { ok: false, refusal: 'phone_ambiguous' };
}

/** An email address lower-cased and validated, or the reason it is not one. */
export function canonicalizeEmail(value: string): CanonicalizationResult {
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (normalized.length === 0) return { ok: false, refusal: 'empty' };
  const localPart = normalized.slice(0, normalized.indexOf('@'));
  const valid =
    normalized.length <= 254 &&
    EMAIL_PATTERN.test(normalized) &&
    !normalized.includes('..') &&
    !localPart.startsWith('.') &&
    !localPart.endsWith('.');
  return valid
    ? { ok: true, handle: { channel: 'email', value: normalized, canonicalizerVersion: CANONICALIZER_VERSION } }
    : { ok: false, refusal: 'email_invalid' };
}

/**
 * One handle in the only spelling the suppression set stores. The channel is chosen
 * the way the old module chose it: an `@` makes it an address, everything else is
 * tried as a number.
 */
export function canonicalizeHandle(value: string): CanonicalizationResult {
  const raw = value.normalize('NFKC').trim();
  if (raw.length === 0) return { ok: false, refusal: 'empty' };
  return raw.includes('@') ? canonicalizeEmail(raw) : canonicalizePhone(raw);
}

/**
 * Every route of one firm as a canonical handle, de-duplicated, in a stable order, so
 * a replayed suppression writes exactly the same set. A handle neither canonicaliser
 * accepts is dropped from the list rather than stored raw; the firm-level suppression
 * still stands, so a firm is never left unsuppressed because one route was unreadable.
 */
export function canonicalizeRoutes(
  routes: readonly { readonly channel: string; readonly value: string }[],
): CanonicalHandle[] {
  const seen = new Map<string, CanonicalHandle>();
  for (const route of routes) {
    if (route.channel !== 'phone' && route.channel !== 'email') continue;
    const result = canonicalizeHandle(route.value);
    if (!result.ok) continue;
    if (result.handle.channel !== route.channel) continue;
    if (!seen.has(result.handle.value)) seen.set(result.handle.value, result.handle);
  }
  return [...seen.values()].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/**
 * Whether a stored event's canonicalizer version is one this build can still reason
 * about. Appendix G 21: an unsupported canonicalizer change is refused, never
 * silently reinterpreted.
 */
export const SUPPORTED_CANONICALIZER_VERSIONS: readonly string[] = Object.freeze([CANONICALIZER_VERSION]);

export function isSupportedCanonicalizerVersion(version: string): boolean {
  return SUPPORTED_CANONICALIZER_VERSIONS.includes(version);
}

/** The ten-minute window in which a salesperson may correct their own manual suppression (10.2). */
export const MANUAL_SUPPRESSION_CORRECTION_MILLISECONDS = 10 * 60 * 1000;

export type CorrectionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly refusal: 'not_your_event' | 'not_salesperson_originated' | 'window_expired';
    };

/**
 * Whether a salesperson may correct a suppression event. Three refusals and no fourth:
 * a prospect-originated request can never use this path (Appendix G 30), someone
 * else's event is not yours to correct, and the window is ten minutes of database time.
 */
export function mayCorrectSuppression(input: {
  readonly event: { readonly source: string; readonly actorUserId: string | null; readonly recordedAt: string };
  readonly actorUserId: string;
  readonly now: string;
}): CorrectionDecision {
  if (input.event.source !== 'salesperson_manual') {
    return { allowed: false, refusal: 'not_salesperson_originated' };
  }
  if (input.event.actorUserId === null || input.event.actorUserId !== input.actorUserId) {
    return { allowed: false, refusal: 'not_your_event' };
  }
  const recorded = Date.parse(input.event.recordedAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(recorded) || !Number.isFinite(now)) {
    throw new TypeError('a correction window is measured between two ISO 8601 instants');
  }
  // The deadline is exclusive: at exactly ten minutes the finalizer owns the event.
  return now - recorded < MANUAL_SUPPRESSION_CORRECTION_MILLISECONDS
    ? { allowed: true }
    : { allowed: false, refusal: 'window_expired' };
}
