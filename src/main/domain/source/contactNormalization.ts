import { z } from 'zod';

/** V1 intentionally uses the United States as the only default for non-E.164 phones. */
export const V1_DEFAULT_PHONE_REGION = 'US' as const;

const phoneInputSchema = z.string().transform((value, context) => {
  const normalized = value.normalize('NFKC').trim();
  if (normalized.startsWith('+')) {
    if (/^\+[\d\s().-]+$/.test(normalized)) {
      const digits = normalized.slice(1).replace(/\D/g, '');
      if (/^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
    }
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Explicit international phones must be canonical E.164.',
    });
    return z.NEVER;
  }
  if (!/^[\d\s().-]+$/.test(normalized)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Phone is invalid.' });
    return z.NEVER;
  }
  const digits = normalized.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Phone is ambiguous or invalid under the V1 US default region.',
  });
  return z.NEVER;
});

const emailInputSchema = z.string().transform((value, context) => {
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  const localPart = normalized.slice(0, normalized.indexOf('@'));
  if (
    normalized.length <= 254
    && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)
    && !normalized.includes('..')
    && !localPart.startsWith('.')
    && !localPart.endsWith('.')
  ) {
    return normalized;
  }
  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Email is invalid.' });
  return z.NEVER;
});

export function normalizePhone(value: string): string {
  return phoneInputSchema.parse(value);
}

export function normalizeEmail(value: string): string {
  return emailInputSchema.parse(value);
}
