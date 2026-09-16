import type { AccountSource } from '../../../shared/contracts/accountContract';
import { companyDraftEmailSchema, companyDraftMailboxOccurrences } from '../../../shared/contracts/localCompanyDraftContract';

export type InboxCandidate = { sourceId: string; email: string; quote: string };
export type ExcludedInbox = { sourceId: string; email: string; matchedWord: string };
export type InboxCandidates = { candidates: InboxCandidate[]; excluded: ExcludedInbox[] };
export type Span = { start: number; end: number };
export type Line = Span & { blank: boolean };

/** The same ASCII mailbox token companyDraftMailboxOccurrences consumes; standalone-ness is re-checked through that function. */
export const mailboxToken = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g;
/** Whole words only, so "residential" never matches: the domain's conflict words plus the ones the founder confirms against. */
const exclusionWord = /\b(?:tenants?|residents?|emergenc(?:y|ies)|maintenance|repairs?|urgent(?:ly)?|after[ -]?hours)\b/i;
/** accountRepository.companyDraftPublication (and its phone twin) refuses such excerpts outright, so nothing can be offered from them. */
export const unpublishable = /[<>]|\b(?:https?:|mailto:|javascript:)|\b(?:script|href|src)\s*=/i;
/** quoteSchema maximum in localCompanyDraftContract. */
const quoteLimit = 12000;

/**
 * Deterministic local extraction over saved excerpts, no model call: every standalone address with the exact passage
 * around it, and every address a tenant, emergency, maintenance, repairs, urgent, resident or after-hours word rules out.
 * Nothing here verifies an address or admits anything; the founder still reads the passage and confirms.
 */
export function inboxCandidates(sources: readonly Pick<AccountSource, 'id' | 'excerpt' | 'permitted'>[]): InboxCandidates {
  const candidates: InboxCandidate[] = [], excluded: ExcludedInbox[] = [], conflicted = new Set<string>();
  for (const source of sources) {
    if (!source.permitted || unpublishable.test(source.excerpt)) continue;
    const lines = lineTable(source.excerpt);
    for (const email of mailboxes(source.excerpt)) {
      const occurrences = companyDraftMailboxOccurrences(source.excerpt, email);
      if (!occurrences.length) continue;
      const passages = occurrences.map(token => passage(source.excerpt, lines, token));
      // Other addresses inside the passage describe themselves, not this one, so they are masked before the word scan.
      const word = matchedWord(email.slice(0, email.lastIndexOf('@')).replace(/[._+-]/g, ' '))
        ?? passages.map(text => matchedWord(text.replace(mailboxToken, ' '))).find(found => found !== null) ?? null;
      if (word === null) candidates.push({ sourceId: source.id, email, quote: passages[0] });
      else { excluded.push({ sourceId: source.id, email, matchedWord: word }); conflicted.add(email); }
    }
  }
  // The domain rejects an address once any of its saved lines conflicts, whichever source the quote comes from.
  return { candidates: candidates.filter(candidate => !conflicted.has(candidate.email)), excluded };
}
/** The first exclusion word in the text, as written, or null. Shared with the phone candidates so both steps exclude on the same words. */
export function matchedWord(text: string): string | null { return exclusionWord.exec(text)?.[0] ?? null; }
/** Distinct lowercased addresses in first-occurrence order; only tokens the contract parses as an address. */
function mailboxes(text: string): string[] {
  const found = new Set<string>();
  for (const token of text.matchAll(mailboxToken)) { const parsed = companyDraftEmailSchema.safeParse(token[0]); if (parsed.success) found.add(parsed.data); }
  return [...found];
}
export function lineTable(text: string): Line[] {
  const lines: Line[] = [];
  for (let start = 0; ;) {
    const newline = text.indexOf('\n', start), end = newline === -1 ? text.length : newline;
    lines.push({ start, end, blank: text.slice(start, end).trim() === '' });
    if (newline === -1) return lines;
    start = newline + 1;
  }
}
/**
 * The blank-line-delimited paragraph around the token when it spans more than one line; otherwise the token's line with
 * up to `neighbours.before` non-blank lines before and `neighbours.after` after (two and one for an address), exactly as saved.
 * Always a trimmed verbatim slice containing the occurrence, so it passes the same occurrence check the domain applies before publication.
 */
export function passage(text: string, lines: Line[], token: Span, neighbours: { before: number; after: number } = { before: 2, after: 1 }): string {
  const at = lines.findIndex(line => line.start <= token.start && token.start < line.end);
  if (at === -1) return text.slice(token.start, token.end);
  let first = at, last = at;
  while (first > 0 && !lines[first - 1].blank) first--;
  while (last < lines.length - 1 && !lines[last + 1].blank) last++;
  if (first === last) {
    for (let count = 0; first > 0 && count < neighbours.before;) { first--; if (!lines[first].blank) count++; }
    for (let count = 0; last < lines.length - 1 && count < neighbours.after;) { last++; if (!lines[last].blank) count++; }
  }
  for (const span of [{ start: lines[first].start, end: lines[last].end }, lines[at], token]) {
    const quote = text.slice(span.start, span.end).trim();
    if (quote.length <= quoteLimit) return quote;
  }
  return text.slice(token.start, token.end);
}
