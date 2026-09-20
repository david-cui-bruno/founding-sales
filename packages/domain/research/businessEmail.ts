/**
 * The business email a firm publishes on its own website.
 *
 * Ported from `src/main/research/businessEmailDiscovery.ts`, whose docstring is worth
 * keeping in one sentence: *finding an address is not permission to use it*. This
 * module chooses at most one address per firm from pages a fetch already read. It
 * performs no network access, reads no store, and grants nothing. Whether the address
 * becomes a `usable` route is the versioned policy's decision in `routeEligibility.ts`,
 * and whether anything is ever sent to it is a deliberate enrollment (invariant 8).
 *
 * The rules, in the order they apply:
 *
 *   1. Only addresses that actually appear in the fetched text, including `mailto:`
 *      links. Nothing is ever guessed from a pattern such as `info@` plus the domain.
 *   2. The address must be on the firm's own website domain or a subdomain of it. A
 *      third-party domain is refused even when the firm's own page publishes it,
 *      because it is somebody else's mailbox.
 *   3. A free-mail address is refused outright, even on a "matching" domain.
 *   4. An address a page qualified as tenant, emergency or after-hours contact is
 *      refused. That negative evidence wins from *any* page, whatever the order.
 *   5. At most one survives: a role mailbox beats a personal name, earlier entries in
 *      `BUSINESS_EMAIL_ROLE_LOCAL_PARTS` beat later ones, and with no role mailbox the
 *      first address in page order wins. Which of the three happened is recorded.
 *
 * A firm that publishes none yields `null`, and the honest consequence downstream is
 * that no email route exists. That is the truthful state, never a guessed address.
 */

/**
 * Free-mail providers whose mailboxes are personal accounts rather than a firm's
 * published business inbox. The list is explicit by intent; an unlisted consumer
 * provider is caught instead by the on-domain rule, which is the rule that decides.
 */
export const FREE_MAIL_DOMAINS: readonly string[] = Object.freeze([
  'aol.com', 'att.net', 'bellsouth.net', 'btinternet.com', 'charter.net', 'comcast.net', 'cox.net',
  'earthlink.net', 'fastmail.com', 'frontier.com', 'gmail.com', 'gmx.com', 'gmx.net', 'googlemail.com',
  'hotmail.co.uk', 'hotmail.com', 'hushmail.com', 'icloud.com', 'inbox.com', 'juno.com', 'live.co.uk',
  'live.com', 'mac.com', 'mail.com', 'me.com', 'msn.com', 'optonline.net', 'outlook.co.uk',
  'outlook.com', 'pm.me', 'proton.me', 'protonmail.com', 'qq.com', 'roadrunner.com', 'rocketmail.com',
  'rr.com', 'sbcglobal.net', 'sky.com', 'tutanota.com', 'verizon.net', 'windstream.net', 'yahoo.co.uk',
  'yahoo.com', 'yandex.com', 'ymail.com', 'zoho.com',
]);
const FREE_MAIL = new Set(FREE_MAIL_DOMAINS);

/**
 * Role mailboxes a firm publishes for whoever answers that day, in preference order.
 * A role mailbox is preferred over a person's name because the correspondence is with
 * the firm, not with a named individual who may have left.
 */
export const BUSINESS_EMAIL_ROLE_LOCAL_PARTS: readonly string[] = Object.freeze([
  'info', 'office', 'hello', 'contact', 'inquiries', 'enquiries', 'admin', 'management',
  'propertymanagement', 'leasing', 'rentals', 'team', 'frontdesk', 'reception', 'mail', 'sales',
  'support', 'help',
]);
const ROLE_PREFERENCE = new Map(BUSINESS_EMAIL_ROLE_LOCAL_PARTS.map((part, index) => [part, index]));

export type BusinessEmailSelection = 'role_mailbox' | 'sole_on_domain_address' | 'first_on_domain_address';

/** Why no candidate became the firm's business email. Counted, never shown as an address. */
export type BusinessEmailRefusal = 'free_mail' | 'off_domain' | 'withheld_contact' | 'unparsable';

export interface BusinessEmailCandidate {
  readonly email: string;
  readonly sourceReference: string;
  readonly order: number;
}

export interface BusinessEmailFinding {
  readonly email: string;
  readonly sourceReference: string;
  readonly selection: BusinessEmailSelection;
  /** Every distinct on-domain candidate considered, in page order, so the choice re-reads. */
  readonly considered: readonly string[];
}

export interface BusinessEmailResult {
  readonly finding: BusinessEmailFinding | null;
  readonly refused: Readonly<Record<BusinessEmailRefusal, number>>;
}

/** One page as the fetch already holds it: its evidence reference and its text. */
export interface BusinessEmailPage {
  readonly sourceReference: string;
  readonly text: string;
}

const ADDRESS =
  /(?:mailto:)?[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/gu;
const VALID =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** True when `host` is the firm's domain or a subdomain, never a name that merely ends in it. */
export function onCompanyDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The lower-cased address a token names, or null when it is not one address. */
function normalize(raw: string): string | null {
  const token = raw
    .replace(/^mailto:/iu, '')
    .replace(/[.,;:!?)\]}>'"]+$/u, '')
    .toLowerCase();
  return token.length >= 3 && token.length <= 254 && VALID.test(token) ? token : null;
}

/** Every distinct candidate the pages publish, in page order. */
export function businessEmailCandidates(pages: readonly BusinessEmailPage[]): readonly BusinessEmailCandidate[] {
  const seen = new Set<string>();
  const candidates: BusinessEmailCandidate[] = [];
  for (const page of pages) {
    for (const match of page.text.match(ADDRESS) ?? []) {
      const email = normalize(match);
      if (email === null || seen.has(email)) continue;
      seen.add(email);
      candidates.push({ email, sourceReference: page.sourceReference, order: candidates.length });
    }
  }
  return candidates;
}

/**
 * Lines a page qualified as tenant, emergency or after-hours contact, and the
 * addresses they carry. Ported from `withheldContactTargets`: an address published
 * for a tenant emergency is not a prospecting route, and that negative evidence from
 * any page wins over a business label on another.
 */
export function withheldEmails(pages: readonly BusinessEmailPage[]): readonly string[] {
  const withheld = new Set<string>();
  for (const page of pages) {
    for (const line of page.text.split('\n')) {
      if (!/emergency|tenant|after.hours/iu.test(line)) continue;
      for (const match of line.match(ADDRESS) ?? []) {
        const email = normalize(match);
        if (email !== null) withheld.add(email);
      }
    }
  }
  return [...withheld].sort();
}

/**
 * The single business email for one firm, or null with the reasons nothing was
 * chosen. Pure and total: the same pages and the same domain always give the same
 * answer, and no input can make it invent an address.
 */
export function findBusinessEmail(input: {
  /** The firm's own website domain: lower case, no scheme, no `www.`. */
  readonly domain: string | null;
  readonly pages: readonly BusinessEmailPage[];
  /** Addresses a page qualified as tenant or emergency contact. */
  readonly withheld?: readonly string[] | undefined;
}): BusinessEmailResult {
  const refused: Record<BusinessEmailRefusal, number> = {
    free_mail: 0,
    off_domain: 0,
    withheld_contact: 0,
    unparsable: 0,
  };
  const domain = (input.domain ?? '').trim().toLowerCase().replace(/^www\./u, '');
  if (domain === '' || !DOMAIN.test(domain)) {
    refused.unparsable += 1;
    return { finding: null, refused: Object.freeze(refused) };
  }

  const withheld = new Set((input.withheld ?? withheldEmails(input.pages)).map(value => value.toLowerCase()));
  const eligible: BusinessEmailCandidate[] = [];
  for (const candidate of businessEmailCandidates(input.pages)) {
    const host = candidate.email.slice(candidate.email.lastIndexOf('@') + 1);
    // Free mail is refused first and reported as free mail, even when the firm's own
    // domain happens to be one, so the count says what actually happened.
    if (FREE_MAIL.has(host)) {
      refused.free_mail += 1;
      continue;
    }
    if (!onCompanyDomain(host, domain)) {
      refused.off_domain += 1;
      continue;
    }
    if (withheld.has(candidate.email)) {
      refused.withheld_contact += 1;
      continue;
    }
    eligible.push(candidate);
  }

  const first = eligible[0];
  if (first === undefined) return { finding: null, refused: Object.freeze(refused) };
  const considered = Object.freeze(eligible.map(candidate => candidate.email));
  const ranked = eligible
    .map(candidate => ({
      candidate,
      rank: ROLE_PREFERENCE.get(candidate.email.slice(0, candidate.email.indexOf('@'))),
    }))
    .filter((entry): entry is { candidate: BusinessEmailCandidate; rank: number } => entry.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || a.candidate.order - b.candidate.order);
  const role = ranked[0]?.candidate;
  const chosen = role ?? first;
  const selection: BusinessEmailSelection =
    role !== undefined ? 'role_mailbox' : eligible.length === 1 ? 'sole_on_domain_address' : 'first_on_domain_address';
  return {
    finding: Object.freeze({
      email: chosen.email,
      sourceReference: chosen.sourceReference,
      selection,
      considered,
    }),
    refused: Object.freeze(refused),
  };
}
