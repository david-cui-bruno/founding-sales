import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { admitCompanyPhoneRouteSchema, companyPhoneMentions, companyPhoneOccurrences, companyPhoneRouteReceiptSchema, companyPhoneRouteReply,
  companyPhoneSchema, normaliseCompanyPhone } from '../../src/shared/contracts/localCompanyPhoneRouteContract';

const phone = '+14015723322';
// Shaped like the saved Lenox source from the 2026-09-16 walkthrough; the quote is the whole "Contact Us" block David reviewed.
const lenoxQuote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';
const lenox = 'Lenox Management\n\nProperty management, leasing and REO services across Rhode Island and Southeastern Massachusetts since 2004.\n\n'
  + lenoxQuote + '\n\nOur in-house maintenance team coordinates repairs for the properties we manage.';
const publication = { sourceId: 'source-lenox', url: 'https://lenoxmanagement.com/', sha256: 'c'.repeat(64), fetchedAt: '2026-09-15T18:40:27.911Z', quote: lenoxQuote };
const request = () => ({ commandId: randomUUID(), accountId: 'lenox', expectedAccountVersion: 2, phone, sourceId: 'source-lenox', quote: lenoxQuote,
  selection: 'published_company_business_phone' as const });
const receipt = (input: ReturnType<typeof request>) => ({ commandId: input.commandId, accountId: input.accountId, accountVersion: input.expectedAccountVersion + 1,
  route: { routeId: 'route-1', routeVersion: 1, phone: input.phone, personId: null }, publication: { ...publication, sourceId: input.sourceId, quote: input.quote }, selection: input.selection });

describe('normaliseCompanyPhone', () => {
  it.each(['401-572-3322', '(401) 572-3322', '(401)572-3322', '401.572.3322', '401 572 3322', '4015723322', '1-401-572-3322', '14015723322',
    '+1 401-572-3322', '+1 (401) 572-3322', '+14015723322', ' 401-572-3322 '])('normalises the US form %j to E.164', written => {
    expect(normaliseCompanyPhone(written)).toBe(phone);
  });
  it.each(['572-3322', '+44 20 7946 0958', '020 7946 0958', '101-572-3322', '401-172-3322', '+2 401 572 3322', '+401-572-3322', 'call 401-572-3322',
    '4015723322x12', '401-572-33221', '', '   ', '2026-09-15'])('is not a candidate for %j', written => {
    expect(normaliseCompanyPhone(written)).toBeNull();
  });
  it('accepts only the stored E.164 form as a route value', () => {
    expect(companyPhoneSchema.safeParse(phone).success).toBe(true);
    for (const value of ['4015723322', '+1 401 572 3322', '+14015723322 ', '+11015723322', '+140157233221']) expect(companyPhoneSchema.safeParse(value).success).toBe(false);
  });
});

describe('companyPhoneOccurrences', () => {
  it('finds the whole written occurrence in a Lenox-shaped saved source', () => {
    const found = companyPhoneOccurrences(lenox, phone);
    expect(found).toHaveLength(1);
    expect(lenox.slice(found[0].start, found[0].end)).toBe('401-572-3322');
    expect(companyPhoneOccurrences(lenoxQuote, phone)).toHaveLength(1);
    expect(companyPhoneOccurrences(lenox, '+14015550199')).toEqual([]);
  });
  it('accepts every written US form that normalises to the same value', () => {
    const text = 'Call (401) 572-3322, 1.401.572.3322, +1 401 572 3322 or 4015723322 today';
    const found = companyPhoneOccurrences(text, phone);
    expect(found.map(token => text.slice(token.start, token.end))).toEqual(['(401) 572-3322', '1.401.572.3322', '+1 401 572 3322', '4015723322']);
  });
  it('skips digits glued to a longer number, a date-like prefix or a suffix continuation, and never consumes seven-digit or non-US numbers', () => {
    expect(companyPhoneOccurrences('24015723322', phone)).toEqual([]);
    expect(companyPhoneOccurrences('4015723322401', phone)).toEqual([]);
    expect(companyPhoneOccurrences('2026-401-572-3322', phone)).toEqual([]);
    expect(companyPhoneOccurrences('401-572-3322-1234', phone)).toEqual([]);
    expect(companyPhoneOccurrences('401-572-3322/2', phone)).toEqual([]);
    expect(companyPhoneOccurrences('572-3322', '+15723322')).toEqual([]);
    expect(companyPhoneOccurrences('+44 20 7946 0958', '+442079460958')).toEqual([]);
    // An extension marker after the number is still the same line.
    expect(companyPhoneOccurrences('401-572-3322 ext. 12 or 401-572-3322x12', phone)).toHaveLength(2);
  });
  it('lists distinct mentions in first-occurrence order with their normalised value', () => {
    const text = 'Office 401-572-3322\nTenant emergencies (401) 555-0199\nAgain 1-401-572-3322';
    expect(companyPhoneMentions(text).map(mention => [text.slice(mention.start, mention.end), mention.phone])).toEqual([
      ['401-572-3322', phone], ['(401) 555-0199', '+14015550199'], ['1-401-572-3322', phone]]);
  });
});

describe('phone route admission contract', () => {
  it('requires the E.164 value, the fixed selection and no unknown keys', () => {
    const input = request();
    expect(admitCompanyPhoneRouteSchema.parse(input)).toEqual(input);
    expect(admitCompanyPhoneRouteSchema.safeParse({ ...input, phone: '401-572-3322' }).success).toBe(false);
    expect(admitCompanyPhoneRouteSchema.safeParse({ ...input, selection: 'published_company_business_inbox' }).success).toBe(false);
    expect(admitCompanyPhoneRouteSchema.safeParse({ ...input, quote: '   ' }).success).toBe(false);
    expect(admitCompanyPhoneRouteSchema.safeParse({ ...input, extra: true }).success).toBe(false);
    expect(admitCompanyPhoneRouteSchema.safeParse({ ...input, expectedAccountVersion: 0 }).success).toBe(false);
  });
  it('accepts a receipt only when the verbatim quote contains a whole occurrence of the number and the route has no person', () => {
    const input = request(), valid = receipt(input);
    expect(companyPhoneRouteReceiptSchema.parse(valid)).toEqual(valid);
    expect(companyPhoneRouteReceiptSchema.safeParse({ ...valid, publication: { ...valid.publication, quote: 'Contact Us' } }).success).toBe(false);
    expect(companyPhoneRouteReceiptSchema.safeParse({ ...valid, publication: { ...valid.publication, quote: 'Call 24015723322' } }).success).toBe(false);
    expect(companyPhoneRouteReceiptSchema.safeParse({ ...valid, route: { ...valid.route, personId: 'person-1' } }).success).toBe(false);
    expect(companyPhoneRouteReceiptSchema.safeParse({ ...valid, route: { ...valid.route, phone: '401-572-3322' } }).success).toBe(false);
    expect(companyPhoneRouteReceiptSchema.safeParse({ ...valid, called: true }).success).toBe(false);
  });
  it('binds the reply to the exact command identity and reviewed values', () => {
    const input = request(), valid = receipt(input);
    expect(companyPhoneRouteReply(input).parse(valid)).toEqual(valid);
    expect(companyPhoneRouteReply(input).safeParse({ ...valid, commandId: randomUUID() }).success).toBe(false);
    expect(companyPhoneRouteReply(input).safeParse({ ...valid, accountId: 'other' }).success).toBe(false);
    expect(companyPhoneRouteReply(input).safeParse({ ...valid, accountVersion: input.expectedAccountVersion + 2 }).success).toBe(false);
    expect(companyPhoneRouteReply(input).safeParse({ ...valid, route: { ...valid.route, phone: '+14015550199' }, publication: { ...valid.publication, quote: 'Tenant line 401-555-0199' } }).success).toBe(false);
    expect(companyPhoneRouteReply(input).safeParse({ ...valid, publication: { ...valid.publication, sourceId: 'other-source' } }).success).toBe(false);
    expect(companyPhoneRouteReply(input).safeParse({ ...valid, publication: { ...valid.publication, quote: '401-572-3322' } }).success).toBe(false);
  });
});
