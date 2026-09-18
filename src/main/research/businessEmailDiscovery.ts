import type { BusinessEmailSelection } from '../../shared/contracts/accountContract';

/**
 * The business email a firm publishes on its own website (design D13, lane 39).
 *
 * Lane 31 shipped the five follow-up templates and the send-or-hold decision, and then every sequence email step
 * held with `no_business_email`, because nothing in the system ever recorded an address for a firm: Places returns
 * none, and the page extraction recorded role, quoted facts and target fit only. This module is that missing step
 * and nothing more. It is pure text analysis over pages the bounded page fetch already read; it performs no
 * network access, reads no store, and grants no permission to write to anybody. Finding an address is not
 * permission to use it: the sequence step's own standing approval is what allows a send.
 *
 * The rules, in the order they are applied:
 *   1. Only `mailto:` links and plain addresses that actually appear in the fetched page text are candidates.
 *      Nothing is ever guessed from a pattern such as `info@` plus the domain.
 *   2. The address must be on the firm's own website domain, or on a subdomain of it. A third-party domain is
 *      refused even when the firm's own page publishes it, because it is somebody else's mailbox.
 *   3. A free-mail address is refused outright, even on a "matching" domain, from the explicit list below.
 *   4. An address a page qualified as tenant or emergency contact is refused: that negative evidence is decided by
 *      the caller, which already computes it for phone routes, and passed in as `withheldEmails`.
 *   5. At most one address survives. A role mailbox (`info@`, `office@`, `hello@`, …) is preferred over a personal
 *      name; among role mailboxes the earlier entry in `BUSINESS_EMAIL_ROLE_LOCAL_PARTS` wins; with no role mailbox
 *      the first address in page order wins. Which of those three happened is recorded as the selection reason.
 *
 * A firm with no on-domain address yields `null`, and the sequence step keeps holding with `no_business_email`,
 * truthfully. That is the honest state, never a guessed address.
 */

/**
 * Free-mail providers whose mailboxes are personal accounts, not a firm's published business inbox. An address on
 * one of these domains is refused even if the firm's own site publishes it, because the domain does not belong to
 * the firm and the firm cannot be shown to control it. The list is explicit and exhaustive by intent: an unlisted
 * consumer provider is caught instead by the on-domain rule, which is the rule that actually decides.
 */
export const FREE_MAIL_DOMAINS: readonly string[] = Object.freeze([
  'aol.com', 'att.net', 'bellsouth.net', 'btinternet.com', 'charter.net', 'comcast.net', 'cox.net', 'earthlink.net',
  'fastmail.com', 'frontier.com', 'gmail.com', 'gmx.com', 'gmx.net', 'googlemail.com', 'hotmail.co.uk', 'hotmail.com',
  'hushmail.com', 'icloud.com', 'inbox.com', 'juno.com', 'live.co.uk', 'live.com', 'mac.com', 'mail.com', 'me.com',
  'msn.com', 'optonline.net', 'outlook.co.uk', 'outlook.com', 'pm.me', 'proton.me', 'protonmail.com', 'qq.com',
  'roadrunner.com', 'rocketmail.com', 'rr.com', 'sbcglobal.net', 'sky.com', 'tutanota.com', 'verizon.net',
  'windstream.net', 'yahoo.co.uk', 'yahoo.com', 'yandex.com', 'ymail.com', 'zoho.com',
]);
const freeMail = new Set(FREE_MAIL_DOMAINS);

/**
 * Role mailboxes a firm publishes for whoever answers the phone that day, in preference order. A role mailbox is
 * preferred over a person's name because the follow-up is business correspondence with the firm, not with a named
 * individual who may have left.
 */
export const BUSINESS_EMAIL_ROLE_LOCAL_PARTS: readonly string[] = Object.freeze([
  'info', 'office', 'hello', 'contact', 'inquiries', 'enquiries', 'admin', 'management', 'propertymanagement',
  'leasing', 'rentals', 'team', 'frontdesk', 'reception', 'mail', 'sales', 'support', 'help',
]);
const rolePreference = new Map(BUSINESS_EMAIL_ROLE_LOCAL_PARTS.map((part, index) => [part, index]));

/** Why no candidate became the firm's business email. Counted for the tick record, never shown as an address. */
export type BusinessEmailRefusal = 'free_mail' | 'off_domain' | 'withheld_contact' | 'unparsable';
export type BusinessEmailCandidate = Readonly<{ email: string; sourceId: string; order: number }>;
export type BusinessEmailFinding = Readonly<{
  email: string; sourceId: string; selection: BusinessEmailSelection;
  /** Every distinct on-domain candidate considered, in page order, so the choice can be re-read later. */
  considered: readonly string[];
}>;
export type BusinessEmailResult = Readonly<{
  finding: BusinessEmailFinding | null;
  refused: Readonly<Record<BusinessEmailRefusal, number>>;
}>;

/** One page as the page provider already holds it: the source receipt's id and the text it recorded. */
export type BusinessEmailPage = Readonly<{ sourceId: string; text: string }>;

/** Everything that looks like an address, including the `mailto:` form, without deciding anything about it yet. */
const ADDRESS = /(?:mailto:)?[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;
const VALID = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `true` when `host` is the firm's own website domain or a subdomain of it, never a domain that merely ends in it. */
export function onCompanyDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The lower-cased address a token names, or `null` when the token is not one address this code will act on. */
function normalize(raw: string): string | null {
  // A sentence-ending period or a stray bracket is not part of the published mailbox.
  const token = raw.replace(/^mailto:/i, '').replace(/[.,;:!?)\]}>'"]+$/, '').toLowerCase();
  return token.length >= 3 && token.length <= 254 && VALID.test(token) ? token : null;
}

/**
 * Every distinct candidate the fetched pages actually publish, in page order. Exported so the caller can count what
 * it refused without re-running the regex, and so the ordering rule is testable on its own.
 */
export function businessEmailCandidates(pages: readonly BusinessEmailPage[]): BusinessEmailCandidate[] {
  const seen = new Set<string>();
  const candidates: BusinessEmailCandidate[] = [];
  for (const page of pages) {
    for (const match of page.text.match(ADDRESS) ?? []) {
      const email = normalize(match);
      if (email === null || seen.has(email)) continue;
      seen.add(email);
      candidates.push(Object.freeze({ email, sourceId: page.sourceId, order: candidates.length }));
    }
  }
  return candidates;
}

/**
 * The single business email for one firm, or `null` with the reasons nothing was chosen. Pure and total: the same
 * pages and the same domain always give the same answer, and no input can make it invent an address.
 */
export function findBusinessEmail(input: {
  /** The firm's own website domain, exactly as the account record holds it (lower-case, no scheme, no `www.`). */
  domain: string | null;
  pages: readonly BusinessEmailPage[];
  /** Addresses a page qualified as tenant or emergency contact. Negative evidence from any page wins. */
  withheldEmails?: readonly string[];
}): BusinessEmailResult {
  const refused: Record<BusinessEmailRefusal, number> = { free_mail: 0, off_domain: 0, withheld_contact: 0, unparsable: 0 };
  const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase().replace(/^www\./, '') : '';
  if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    refused.unparsable++;
    return Object.freeze({ finding: null, refused: Object.freeze(refused) });
  }
  const withheld = new Set((input.withheldEmails ?? []).map(value => value.toLowerCase()));
  const eligible: BusinessEmailCandidate[] = [];
  for (const candidate of businessEmailCandidates(input.pages)) {
    const host = candidate.email.slice(candidate.email.lastIndexOf('@') + 1);
    // Free mail is refused first and reported as free mail, even when the firm's domain happens to be a free-mail
    // domain, so the count says what actually happened rather than blaming the on-domain rule for it.
    if (freeMail.has(host)) { refused.free_mail++; continue; }
    if (!onCompanyDomain(host, domain)) { refused.off_domain++; continue; }
    if (withheld.has(candidate.email)) { refused.withheld_contact++; continue; }
    eligible.push(candidate);
  }
  const first = eligible[0];
  if (!first) return Object.freeze({ finding: null, refused: Object.freeze(refused) });
  const considered = Object.freeze(eligible.map(candidate => candidate.email));
  const ranked = eligible
    .map(candidate => ({ candidate, rank: rolePreference.get(candidate.email.slice(0, candidate.email.indexOf('@'))) }))
    .filter((entry): entry is { candidate: BusinessEmailCandidate; rank: number } => entry.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || a.candidate.order - b.candidate.order);
  const role = ranked[0]?.candidate;
  const chosen = role ?? first;
  const selection: BusinessEmailSelection = role ? 'role_mailbox' : eligible.length === 1 ? 'sole_on_domain_address' : 'first_on_domain_address';
  return Object.freeze({ finding: Object.freeze({ email: chosen.email, sourceId: chosen.sourceId, selection, considered }), refused: Object.freeze(refused) });
}
