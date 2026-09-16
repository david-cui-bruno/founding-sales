import { describe, expect, it } from 'vitest';
import { inboxCandidates } from './inboxCandidates';
import { companyDraftMailboxOccurrences } from '../../../shared/contracts/localCompanyDraftContract';

const source = (excerpt: string, id = 'source-1', permitted = true) =>
  ({ id, url: `https://${id}.example/`, fetchedAt: '2026-09-15T18:40:27.911Z', sha256: 'c'.repeat(64), excerpt, permitted });
// Shaped like the saved Lenox source from the 2026-09-16 walkthrough: one block per line, blank lines between blocks.
const lenox = 'Lenox Management\n\nProperty management, leasing and REO services across Rhode Island and Southeastern Massachusetts since 2004.'
  + '\n\nContact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322'
  + '\n\nOur in-house maintenance team coordinates repairs for the properties we manage.';
const lenoxQuote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';
/** The rule accountRepository.companyDraftPublication applies: the quote is verbatim in the excerpt with a standalone occurrence inside it. */
function publishable(excerpt: string, quote: string, email: string) {
  const occurrences = companyDraftMailboxOccurrences(excerpt, email);
  for (let start = excerpt.indexOf(quote); start >= 0; start = excerpt.indexOf(quote, start + 1)) {
    if (occurrences.some(token => token.start >= start && token.end <= start + quote.length)) return true;
  }
  return false;
}

describe('inboxCandidates', () => {
  it('extracts the address and the exact passage around it from a Lenox-shaped saved source', () => {
    const found = inboxCandidates([source(lenox)]);
    expect(found).toEqual({ candidates: [{ sourceId: 'source-1', email: 'info@lenoxmanagement.com', quote: lenoxQuote }], excluded: [] });
    expect(publishable(lenox, lenoxQuote, 'info@lenoxmanagement.com')).toBe(true);
  });
  it('quotes the whole blank-line-delimited paragraph when the address sits inside a multi-line one, lowercasing the address', () => {
    const excerpt = 'Heading\n\nReach the office team at Info@Lenox.example or call 401-572-3322.\nWe reply within one business day.\n\nFooter';
    const quote = 'Reach the office team at Info@Lenox.example or call 401-572-3322.\nWe reply within one business day.';
    expect(inboxCandidates([source(excerpt)])).toEqual({ candidates: [{ sourceId: 'source-1', email: 'info@lenox.example', quote }], excluded: [] });
    expect(publishable(excerpt, quote, 'info@lenox.example')).toBe(true);
  });
  it('keeps Windows line endings verbatim so the quote stays a substring of the saved excerpt', () => {
    const excerpt = 'Contact Us\r\n\r\ninfo@lenox.example\r\n\r\n401-572-3322\r\n';
    const [candidate] = inboxCandidates([source(excerpt)]).candidates;
    expect(candidate.quote).toBe('Contact Us\r\n\r\ninfo@lenox.example\r\n\r\n401-572-3322');
    expect(publishable(excerpt, candidate.quote, 'info@lenox.example')).toBe(true);
  });
  it('lists tenant, emergency, maintenance, repairs, urgent, resident and after-hours addresses as excluded with the matched word', () => {
    const excerpt = ['Contact Us', 'info@lenox.example', '401-555-0100', 'tenants@lenox.example', 'Emergency-Line@lenox.example', 'maintenance@lenox.example',
      'repairs@lenox.example', 'urgent.requests@lenox.example', 'resident_services@lenox.example', 'Support', 'After-hours requests only', 'support@lenox.example', '401-555-0199'].join('\n\n');
    const found = inboxCandidates([source(excerpt)]);
    expect(found.candidates).toEqual([{ sourceId: 'source-1', email: 'info@lenox.example', quote: 'Contact Us\n\ninfo@lenox.example\n\n401-555-0100' }]);
    expect(found.excluded).toEqual([
      { sourceId: 'source-1', email: 'tenants@lenox.example', matchedWord: 'tenants' },
      { sourceId: 'source-1', email: 'emergency-line@lenox.example', matchedWord: 'emergency' },
      { sourceId: 'source-1', email: 'maintenance@lenox.example', matchedWord: 'maintenance' },
      { sourceId: 'source-1', email: 'repairs@lenox.example', matchedWord: 'repairs' },
      { sourceId: 'source-1', email: 'urgent.requests@lenox.example', matchedWord: 'urgent' },
      { sourceId: 'source-1', email: 'resident_services@lenox.example', matchedWord: 'resident' },
      { sourceId: 'source-1', email: 'support@lenox.example', matchedWord: 'After-hours' },
    ]);
  });
  it('matches exclusion words case-insensitively on whole words only, so "residential" and another address in the same block never exclude', () => {
    const excerpt = 'Residential property management\n\ninfo@lenox.example\n\nmaintenance@lenox.example\n\nTENANTS: tenants@lenox.example';
    const found = inboxCandidates([source(excerpt)]);
    expect(found.candidates).toEqual([{ sourceId: 'source-1', email: 'info@lenox.example', quote: 'Residential property management\n\ninfo@lenox.example\n\nmaintenance@lenox.example' }]);
    expect(found.excluded.map(item => [item.email, item.matchedWord])).toEqual([['maintenance@lenox.example', 'maintenance'], ['tenants@lenox.example', 'tenants']]);
  });
  it('excludes an address everywhere once any of its occurrences is flagged, because the domain rejects any conflicting line', () => {
    const found = inboxCandidates([source('Contact Us\n\ninfo@lenox.example', 'source-1'), source('For after-hours emergencies email info@lenox.example', 'source-2')]);
    expect(found).toEqual({ candidates: [], excluded: [{ sourceId: 'source-2', email: 'info@lenox.example', matchedWord: 'after-hours' }] });
  });
  it('offers every clean address as its own candidate, in source and occurrence order', () => {
    const found = inboxCandidates([source('Leasing\n\nleasing@lenox.example\n\n' + lenox, 'source-1'), source('Office: office@lenox.example', 'source-2')]);
    expect(found.excluded).toEqual([]);
    expect(found.candidates.map(item => [item.sourceId, item.email])).toEqual([['source-1', 'leasing@lenox.example'], ['source-1', 'info@lenoxmanagement.com'], ['source-2', 'office@lenox.example']]);
    expect(found.candidates[0].quote).toBe('Leasing\n\nleasing@lenox.example\n\nLenox Management');
    expect(found.candidates[2].quote).toBe('Office: office@lenox.example');
  });
  it('ignores sources that are not permitted or that the domain would never publish from', () => {
    expect(inboxCandidates([source(lenox, 'source-1', false)])).toEqual({ candidates: [], excluded: [] });
    expect(inboxCandidates([source(lenox + '\n\nhttps://lenoxmanagement.com/contact')])).toEqual({ candidates: [], excluded: [] });
    expect(inboxCandidates([source('<p>' + lenox)])).toEqual({ candidates: [], excluded: [] });
    expect(inboxCandidates([])).toEqual({ candidates: [], excluded: [] });
  });
  it('skips tokens glued to letters, quotes the first standalone occurrence once, and never offers non-addresses', () => {
    const excerpt = 'Header caféinfo@lenox.example\n\nContact Us\n\ninfo@lenox.example\n\nFooter info@lenox.example\n\nCall 401-572-3322 or x@y';
    const found = inboxCandidates([source(excerpt)]);
    expect(found).toEqual({ candidates: [{ sourceId: 'source-1', email: 'info@lenox.example', quote: 'Header caféinfo@lenox.example\n\nContact Us\n\ninfo@lenox.example\n\nFooter info@lenox.example' }], excluded: [] });
    expect(publishable(excerpt, found.candidates[0].quote, 'info@lenox.example')).toBe(true);
  });
  it('falls back to the address line when the passage would exceed the 12000 character quote limit', () => {
    const excerpt = 'Contact Us\n\n' + 'x'.repeat(12500) + '\n\ninfo@lenox.example\n\n401-572-3322';
    expect(inboxCandidates([source(excerpt)]).candidates).toEqual([{ sourceId: 'source-1', email: 'info@lenox.example', quote: 'info@lenox.example' }]);
  });
});
