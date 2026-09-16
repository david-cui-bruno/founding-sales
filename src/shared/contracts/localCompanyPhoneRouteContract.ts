import { z } from 'zod';
import { accountIdSchema } from './accountContract';
import { companyDraftPublicationSchema } from './localCompanyDraftContract';
const version = z.number().int().positive().safe();
/** Stored value of a US business line: the E.164 form existing phone routes already use, +1 and ten digits whose area code and exchange
 *  start with 2-9. Saving a route is never a call and never a check that the number answers. */
export const companyPhoneSchema = z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/);
const quoteSchema = z.string().min(1).max(12000).refine(value => value.trim().length > 0);
export const admitCompanyPhoneRouteSchema = z.object({ commandId: z.uuid(), accountId: accountIdSchema, expectedAccountVersion: version,
  phone: companyPhoneSchema, sourceId: accountIdSchema, quote: quoteSchema, selection: z.literal('published_company_business_phone') }).strict();
export const companyPhoneRouteBindingSchema = z.object({ routeId: accountIdSchema, routeVersion: version, phone: companyPhoneSchema, personId: z.null() }).strict();
export const companyPhoneRouteReceiptSchema = z.object({ commandId: z.uuid(), accountId: accountIdSchema, accountVersion: version,
  route: companyPhoneRouteBindingSchema, publication: companyDraftPublicationSchema, selection: z.literal('published_company_business_phone') }).strict()
  .refine(receipt => companyPhoneOccurrences(receipt.publication.quote, receipt.route.phone).length > 0);
export type AdmitCompanyPhoneRoute = z.infer<typeof admitCompanyPhoneRouteSchema>;
export type CompanyPhoneRouteBinding = z.infer<typeof companyPhoneRouteBindingSchema>;
export type CompanyPhoneRouteReceipt = z.infer<typeof companyPhoneRouteReceiptSchema>;
export function companyPhoneRouteReply(input: AdmitCompanyPhoneRoute) {
  return companyPhoneRouteReceiptSchema.refine(result => result.commandId === input.commandId && result.accountId === input.accountId
    && result.accountVersion === input.expectedAccountVersion + 1 && result.route.phone === input.phone
    && result.publication.sourceId === input.sourceId && result.publication.quote === input.quote);
}

/** The written forms a US number takes on a contact page: optional +1 or 1, area code with or without parentheses, dashes, dots or spaces. */
const phoneToken = /(?:\+?1[-. ]?)?(?:\(\d{3}\)|\d{3})[-. ]?\d{3}[-. ]?\d{4}/g;
/** E.164 for one written US number (ten digits, or eleven starting with 1, optionally +1); null for anything else. Deterministic, no lookup. */
export function normaliseCompanyPhone(written: string): string | null {
  const text = written.trim();
  if (!/^\+?[\d\s().-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  const e164 = digits.length === 11 && digits.startsWith('1') ? `+${digits}` : digits.length === 10 && !text.startsWith('+') ? `+1${digits}` : null;
  return e164 !== null && companyPhoneSchema.safeParse(e164).success ? e164 : null;
}
/** Every whole phone-shaped token in the original source with its normalised value, in text order. Digits glued to either side, or joined by
 *  a separator, disqualify a token: "2026-401-572-3322" and "401-572-3322-1234" mention no US number. */
export function companyPhoneMentions(text: string): { start: number; end: number; phone: string }[] {
  const found: { start: number; end: number; phone: string }[] = [];
  for (const token of text.matchAll(phoneToken)) {
    const start = token.index, end = start + token[0].length;
    const before = text.slice(Math.max(0, start - 2), start), after = text.slice(end, end + 2);
    if (/[\p{N}+]$/u.test(before) || /\p{N}[-./]$/u.test(before) || /^\p{N}/u.test(after) || /^[-./]\p{N}/u.test(after)) continue;
    const phone = normaliseCompanyPhone(token[0]);
    if (phone !== null) found.push({ start, end, phone });
  }
  return found;
}
/** Consume whole written occurrences of one stored number in the original source, not clipped quotations. */
export function companyPhoneOccurrences(text: string, phone: string): { start: number; end: number }[] {
  return companyPhoneMentions(text).filter(mention => mention.phone === phone).map(({ start, end }) => ({ start, end }));
}
