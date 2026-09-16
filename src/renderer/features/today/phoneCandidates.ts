import type { AccountSource } from '../../../shared/contracts/accountContract';
import { companyPhoneMentions, companyPhoneOccurrences } from '../../../shared/contracts/localCompanyPhoneRouteContract';
import { lineTable, mailboxToken, matchedWord, passage, unpublishable, type Line, type Span } from './inboxCandidates';

export type PhoneCandidate = { sourceId: string; phone: string; display: string; quote: string };
export type ExcludedPhone = { sourceId: string; phone: string; display: string; matchedWord: string };
export type PhoneCandidates = { candidates: PhoneCandidate[]; excluded: ExcludedPhone[] };

/** A business line usually closes a contact block (heading, address, inbox, number) and the saved text after it starts a new topic, so the
 *  passage around a number on its own line reaches up to three saved lines up and none down. Multi-line paragraphs are quoted whole. */
const neighbours = { before: 3, after: 0 };

/**
 * Deterministic local extraction over saved excerpts, no model call: every whole US number with the exact passage around it, and every number
 * a tenant, emergency, maintenance, repairs, urgent, resident or after-hours word rules out. `phone` is the E.164 value a route stores;
 * `display` is the number exactly as the source writes it. Nothing here verifies a number, calls it or admits anything.
 */
export function phoneCandidates(sources: readonly Pick<AccountSource, 'id' | 'excerpt' | 'permitted'>[]): PhoneCandidates {
  const candidates: PhoneCandidate[] = [], excluded: ExcludedPhone[] = [], conflicted = new Set<string>();
  for (const source of sources) {
    if (!source.permitted || unpublishable.test(source.excerpt)) continue;
    const lines = lineTable(source.excerpt);
    for (const phone of phones(source.excerpt)) {
      const occurrences = companyPhoneOccurrences(source.excerpt, phone);
      const first = occurrences[0];
      if (!first) continue;
      const display = source.excerpt.slice(first.start, first.end);
      const passages = occurrences.map(token => passage(source.excerpt, lines, token, neighbours));
      const word = occurrences.map((token, index) => excludingWord(source.excerpt, lines, token, passages[index])).find(found => found !== null) ?? null;
      if (word === null) candidates.push({ sourceId: source.id, phone, display, quote: passages[0] });
      else { excluded.push({ sourceId: source.id, phone, display, matchedWord: word }); conflicted.add(phone); }
    }
  }
  // The domain rejects a number once any of its saved lines conflicts, whichever source the quote comes from.
  return { candidates: candidates.filter(candidate => !conflicted.has(candidate.phone)), excluded };
}
/** Distinct E.164 values in first-occurrence order; only whole tokens the contract normalises. */
function phones(text: string): string[] {
  return [...new Set(companyPhoneMentions(text).map(mention => mention.phone))];
}
/** Addresses inside the passage describe themselves, not this number, so they are masked. The number's own line is read first, then the
 *  passage from the nearest line upward, so the reported word is the closest label. */
function excludingWord(text: string, lines: Line[], token: Span, quote: string): string | null {
  const at = lines.findIndex(line => line.start <= token.start && token.start < line.end);
  const own = at === -1 ? '' : text.slice(lines[at].start, lines[at].end);
  return matchedWord(mask(own)) ?? quote.split(/\r?\n/).reverse().map(line => matchedWord(mask(line))).find(found => found !== null) ?? null;
}
const mask = (line: string) => line.replace(mailboxToken, ' ');
