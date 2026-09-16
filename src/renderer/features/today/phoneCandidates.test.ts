import { describe, expect, it } from 'vitest';
import { phoneCandidates } from './phoneCandidates';
import { companyPhoneOccurrences } from '../../../shared/contracts/localCompanyPhoneRouteContract';

const source = (excerpt: string, id = 'source-1', permitted = true) =>
  ({ id, url: `https://${id}.example/`, fetchedAt: '2026-09-15T18:40:27.911Z', sha256: 'c'.repeat(64), excerpt, permitted });
const phone = '+14015723322';
// Shaped like the saved Lenox source from the 2026-09-16 walkthrough: one block per line, blank lines between blocks.
const lenoxQuote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';
const lenox = 'Lenox Management\n\nProperty management, leasing and REO services across Rhode Island and Southeastern Massachusetts since 2004.\n\n'
  + lenoxQuote + '\n\nOur in-house maintenance team coordinates repairs for the properties we manage.';
/** The rule accountRepository.companyPhonePublication applies: the quote is verbatim in the excerpt with a whole occurrence inside it. */
function publishable(excerpt: string, quote: string, value: string) {
  const occurrences = companyPhoneOccurrences(excerpt, value);
  for (let start = excerpt.indexOf(quote); start >= 0; start = excerpt.indexOf(quote, start + 1)) {
    if (occurrences.some(token => token.start >= start && token.end <= start + quote.length)) return true;
  }
  return false;
}

describe('phoneCandidates', () => {
  it('extracts the business line with the whole Contact Us block above it from a Lenox-shaped saved source, leaving the sentence after it out', () => {
    const found = phoneCandidates([source(lenox)]);
    expect(found).toEqual({ candidates: [{ sourceId: 'source-1', phone, display: '401-572-3322', quote: lenoxQuote }], excluded: [] });
    expect(publishable(lenox, lenoxQuote, phone)).toBe(true);
  });
  it('quotes the whole blank-line-delimited paragraph when the number sits inside a multi-line one, keeping the written form as the display', () => {
    const excerpt = 'Heading\n\nReach the office team at Info@Lenox.example or call (401) 572-3322.\nWe reply within one business day.\n\nFooter';
    const quote = 'Reach the office team at Info@Lenox.example or call (401) 572-3322.\nWe reply within one business day.';
    expect(phoneCandidates([source(excerpt)])).toEqual({ candidates: [{ sourceId: 'source-1', phone, display: '(401) 572-3322', quote }], excluded: [] });
    expect(publishable(excerpt, quote, phone)).toBe(true);
  });
  it('keeps Windows line endings verbatim so the quote stays a substring of the saved excerpt', () => {
    const excerpt = 'Contact Us\r\n\r\ninfo@lenox.example\r\n\r\n401-572-3322\r\n\r\nMaintenance requests: repairs@lenox.example\r\n';
    const found = phoneCandidates([source(excerpt)]);
    expect(found.candidates.map(candidate => candidate.quote)).toEqual(['Contact Us\r\n\r\ninfo@lenox.example\r\n\r\n401-572-3322']);
    expect(publishable(excerpt, found.candidates[0].quote, phone)).toBe(true);
  });
  it('lists tenant, emergency, maintenance, repairs, urgent, resident and after-hours numbers as excluded with the nearest matched word', () => {
    const excerpt = ['Contact Us', '401-555-0100', 'Tenants: 401-555-0101', 'Emergency line 401-555-0102', 'Maintenance 401-555-0103', 'Repairs 401-555-0104',
      'Urgent requests 401-555-0105', 'Resident services 401-555-0106', 'Support', 'After-hours requests only', '401-555-0107'].join('\n\n');
    const found = phoneCandidates([source(excerpt)]);
    expect(found.candidates).toEqual([{ sourceId: 'source-1', phone: '+14015550100', display: '401-555-0100', quote: 'Contact Us\n\n401-555-0100' }]);
    expect(found.excluded).toEqual([
      { sourceId: 'source-1', phone: '+14015550101', display: '401-555-0101', matchedWord: 'Tenants' },
      { sourceId: 'source-1', phone: '+14015550102', display: '401-555-0102', matchedWord: 'Emergency' },
      { sourceId: 'source-1', phone: '+14015550103', display: '401-555-0103', matchedWord: 'Maintenance' },
      { sourceId: 'source-1', phone: '+14015550104', display: '401-555-0104', matchedWord: 'Repairs' },
      { sourceId: 'source-1', phone: '+14015550105', display: '401-555-0105', matchedWord: 'Urgent' },
      { sourceId: 'source-1', phone: '+14015550106', display: '401-555-0106', matchedWord: 'Resident' },
      { sourceId: 'source-1', phone: '+14015550107', display: '401-555-0107', matchedWord: 'After-hours' },
    ]);
  });
  it('matches exclusion words case-insensitively on whole words only, so "residential" and an address in the same block never exclude', () => {
    const excerpt = 'Residential property management\n\nmaintenance@lenox.example\n\n401-572-3322\n\nTENANTS: 401-555-0199';
    const found = phoneCandidates([source(excerpt)]);
    expect(found.candidates).toEqual([{ sourceId: 'source-1', phone, display: '401-572-3322', quote: 'Residential property management\n\nmaintenance@lenox.example\n\n401-572-3322' }]);
    expect(found.excluded).toEqual([{ sourceId: 'source-1', phone: '+14015550199', display: '401-555-0199', matchedWord: 'TENANTS' }]);
  });
  it('excludes a number everywhere once any of its occurrences is flagged, because the domain rejects any conflicting line', () => {
    const found = phoneCandidates([source('Contact Us\n\n401-572-3322', 'source-1'), source('For after-hours emergencies call (401) 572-3322', 'source-2')]);
    expect(found).toEqual({ candidates: [], excluded: [{ sourceId: 'source-2', phone, display: '(401) 572-3322', matchedWord: 'after-hours' }] });
  });
  it('offers every clean number as its own candidate in source and occurrence order, quoting the first occurrence once', () => {
    const found = phoneCandidates([source('Leasing\n\n(401) 555-0150\n\n' + lenox + '\n\nHours\n\nMonday to Friday\n\n9am to 5pm\n\nAgain 401-572-3322', 'source-1'), source('Office: 1-401-555-0160', 'source-2')]);
    expect(found.excluded).toEqual([]);
    expect(found.candidates.map(item => [item.sourceId, item.phone, item.display])).toEqual([
      ['source-1', '+14015550150', '(401) 555-0150'], ['source-1', phone, '401-572-3322'], ['source-2', '+14015550160', '1-401-555-0160']]);
    expect(found.candidates[0].quote).toBe('Leasing\n\n(401) 555-0150');
    expect(found.candidates[1].quote).toBe(lenoxQuote);
    expect(found.candidates[2].quote).toBe('Office: 1-401-555-0160');
  });
  it('ignores sources that are not permitted or that the domain would never publish from', () => {
    expect(phoneCandidates([source(lenox, 'source-1', false)])).toEqual({ candidates: [], excluded: [] });
    expect(phoneCandidates([source(lenox + '\n\nhttps://lenoxmanagement.com/contact')])).toEqual({ candidates: [], excluded: [] });
    expect(phoneCandidates([source('<p>' + lenox)])).toEqual({ candidates: [], excluded: [] });
    expect(phoneCandidates([])).toEqual({ candidates: [], excluded: [] });
  });
  it('skips digits glued to a longer number and never offers seven-digit or non-US numbers', () => {
    const excerpt = 'Header 24015723322\n\nContact Us\n\n401-572-3322\n\nCall 572-3322 or +44 20 7946 0958';
    const found = phoneCandidates([source(excerpt)]);
    expect(found).toEqual({ candidates: [{ sourceId: 'source-1', phone, display: '401-572-3322', quote: 'Header 24015723322\n\nContact Us\n\n401-572-3322' }], excluded: [] });
    expect(publishable(excerpt, found.candidates[0].quote, phone)).toBe(true);
  });
  it('falls back to the number line when the passage would exceed the 12000 character quote limit', () => {
    const excerpt = 'Contact Us\n\n' + 'x'.repeat(12500) + '\n\n401-572-3322';
    expect(phoneCandidates([source(excerpt)]).candidates).toEqual([{ sourceId: 'source-1', phone, display: '401-572-3322', quote: '401-572-3322' }]);
  });
});
