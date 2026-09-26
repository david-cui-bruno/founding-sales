/**
 * State posture: reference texts, citations, and the firm time-zone seam.
 *
 * Invariant 7 of the specification: "Software records and enforces legal posture; it
 * does not invent it." Every statement and every quotation below is carried over
 * verbatim from `src/shared/contracts/territoryClearanceContract.ts` revision 2, which
 * David checked against the linked sources. Nothing here is drafted, paraphrased or
 * summarised from memory, and nothing here dials, sends or authorizes anything.
 *
 * Revision 3 changes one thing about the old map: section 9.2 resolves a firm's actual
 * IANA zone from its location, not from a state-wide shortcut, because a multi-zone
 * state has no single calling window. `stateDefaultZone` therefore survives only as a
 * **fallback** for single-zone states, and `resolveFirmZone` is the seam G3 and G10
 * fill with postal and coordinate sources.
 */

export const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;
export type UsStateCode = (typeof US_STATE_CODES)[number];

export const US_STATE_NAMES: Readonly<Record<UsStateCode, string>> = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});

export function isUsStateCode(value: string): value is UsStateCode {
  return (US_STATE_CODES as readonly string[]).includes(value);
}

/**
 * States whose area observes more than one IANA zone. Carried over unchanged. Under
 * revision 3 these are not refused outright — a firm in one of them is perfectly
 * callable — but their *state default* is unusable, so the firm's zone has to come
 * from its own location.
 */
export const MULTI_ZONE_STATES: Readonly<Partial<Record<UsStateCode, readonly [string, string]>>> = Object.freeze({
  AK: Object.freeze(['America/Anchorage', 'America/Adak'] as const),
  AZ: Object.freeze(['America/Phoenix', 'America/Denver'] as const),
  FL: Object.freeze(['America/New_York', 'America/Chicago'] as const),
  ID: Object.freeze(['America/Boise', 'America/Los_Angeles'] as const),
  IN: Object.freeze(['America/Indiana/Indianapolis', 'America/Chicago'] as const),
  KS: Object.freeze(['America/Chicago', 'America/Denver'] as const),
  KY: Object.freeze(['America/Kentucky/Louisville', 'America/Chicago'] as const),
  MI: Object.freeze(['America/Detroit', 'America/Menominee'] as const),
  NE: Object.freeze(['America/Chicago', 'America/Denver'] as const),
  NV: Object.freeze(['America/Los_Angeles', 'America/Boise'] as const),
  ND: Object.freeze(['America/Chicago', 'America/Denver'] as const),
  OR: Object.freeze(['America/Los_Angeles', 'America/Boise'] as const),
  SD: Object.freeze(['America/Chicago', 'America/Denver'] as const),
  TN: Object.freeze(['America/New_York', 'America/Chicago'] as const),
  TX: Object.freeze(['America/Chicago', 'America/Denver'] as const),
});

export function isMultiZoneState(value: string): boolean {
  return isUsStateCode(value) && MULTI_ZONE_STATES[value] !== undefined;
}

/**
 * The single-zone default for a state, as a **fallback only**. The old build used this
 * map as the calling window's zone; revision 3 section 9.2 does not, because
 * "multi-zone states do not use a state-wide time-zone shortcut". A state absent from
 * this map, or present in `MULTI_ZONE_STATES`, has no default.
 */
export const STATE_DEFAULT_ZONES: Readonly<Partial<Record<UsStateCode, string>>> = Object.freeze({
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', MA: 'America/New_York',
  MD: 'America/New_York', ME: 'America/New_York', NH: 'America/New_York', NJ: 'America/New_York',
  NY: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York', VT: 'America/New_York',
  VA: 'America/New_York', WV: 'America/New_York', GA: 'America/New_York', NC: 'America/New_York',
  SC: 'America/New_York', OH: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IA: 'America/Chicago', IL: 'America/Chicago',
  LA: 'America/Chicago', MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago',
  OK: 'America/Chicago', WI: 'America/Chicago',
  CO: 'America/Denver', MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver',
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  HI: 'Pacific/Honolulu',
});

/** The fallback zone for a state, or null when the state has no single one. */
export function stateDefaultZone(state: string): string | null {
  const code = state.trim().toUpperCase();
  if (!isUsStateCode(code)) return null;
  if (MULTI_ZONE_STATES[code] !== undefined) return null;
  return STATE_DEFAULT_ZONES[code] ?? null;
}

// ---------------------------------------------------------------------------
// The firm time-zone seam (specification 9.2)
// ---------------------------------------------------------------------------

export const FIRM_ZONE_RULE_VERSION = 'firm-zone.1';

export interface FirmLocation {
  /** An IANA zone already recorded for the firm, with the source rule that produced it. */
  readonly recordedZone?: string | undefined;
  readonly state?: string | undefined;
  readonly postalCode?: string | undefined;
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
}

export type FirmZoneSourceName = 'recorded' | 'postal' | 'coordinates' | 'state_default';

export type FirmZoneResolution =
  | {
      readonly kind: 'resolved';
      readonly zone: string;
      readonly source: FirmZoneSourceName;
      /** `high` is a zone read from the firm's own location; `medium` is the state fallback. */
      readonly confidence: 'high' | 'medium';
      readonly ruleVersion: string;
    }
  | {
      readonly kind: 'unresolved';
      readonly reason: 'no_location' | 'state_spans_zones' | 'state_unknown' | 'no_default_for_state';
      readonly ruleVersion: string;
    };

/**
 * A source G3 or G10 plugs in: a postal-code table, a coordinate lookup, whatever the
 * versioned source rule turns out to be. It returns a zone or nothing; it never throws
 * and never guesses.
 */
export interface FirmZoneSource {
  readonly name: Exclude<FirmZoneSourceName, 'recorded' | 'state_default'>;
  resolve(location: FirmLocation): string | null;
}

/**
 * The firm's actual IANA zone, or the reason there is not one.
 *
 * Order: a zone already recorded for the firm, then each supplied source in order,
 * then the single-zone state default. A multi-zone state with no source is
 * `state_spans_zones` — which blocks calling, exactly as section 9.2 requires
 * ("inability to establish it blocks calling"). It is never the state's first zone.
 */
export function resolveFirmZone(
  location: FirmLocation,
  sources: readonly FirmZoneSource[] = [],
): FirmZoneResolution {
  const recorded = location.recordedZone?.trim();
  if (recorded !== undefined && recorded.length > 0) {
    return { kind: 'resolved', zone: recorded, source: 'recorded', confidence: 'high', ruleVersion: FIRM_ZONE_RULE_VERSION };
  }

  for (const source of sources) {
    const zone = source.resolve(location);
    if (zone !== null && zone.length > 0) {
      return { kind: 'resolved', zone, source: source.name, confidence: 'high', ruleVersion: FIRM_ZONE_RULE_VERSION };
    }
  }

  const state = location.state?.trim().toUpperCase();
  if (state === undefined || state.length === 0) {
    return { kind: 'unresolved', reason: 'no_location', ruleVersion: FIRM_ZONE_RULE_VERSION };
  }
  if (!isUsStateCode(state)) {
    return { kind: 'unresolved', reason: 'state_unknown', ruleVersion: FIRM_ZONE_RULE_VERSION };
  }
  if (isMultiZoneState(state)) {
    return { kind: 'unresolved', reason: 'state_spans_zones', ruleVersion: FIRM_ZONE_RULE_VERSION };
  }
  const fallback = stateDefaultZone(state);
  return fallback === null
    ? { kind: 'unresolved', reason: 'no_default_for_state', ruleVersion: FIRM_ZONE_RULE_VERSION }
    : { kind: 'resolved', zone: fallback, source: 'state_default', confidence: 'medium', ruleVersion: FIRM_ZONE_RULE_VERSION };
}

// ---------------------------------------------------------------------------
// Reference texts. Verbatim; an edit here is a product and legal decision.
// ---------------------------------------------------------------------------

/** Bump when any statement, summary or citation text below changes. */
export const POSTURE_RULES_REVISION = 2;

export interface PostureCitation {
  readonly title: string;
  readonly url: string;
  readonly quote: string;
}

/** The statements the founder confirms. Shown once above the state list; stored with every posture row. */
export const POSTURE_STATEMENTS = Object.freeze({
  businessToBusiness:
    'These are business-to-business calls placed from my Mac to business numbers that each firm lists publicly for its own business (its Google Business Profile listing or its own website). No residential or personal number is dialed.',
  registrationStatusChecked:
    'I have checked whether my business must register as a telephone solicitor or telemarketer in this state before placing these calls, and my registration status satisfies the rule quoted for the state.',
  stateDncSubscriptionChecked:
    'I have checked whether this state requires a subscription to its do-not-call list for these calls, and my subscription status satisfies the rule quoted for the state.',
  consentRuleConfirmed:
    'Consent is never assumed: a request to stop calling is honored at once and recorded, no number with a suppression record is dialed, and calls stay inside the recipient\'s local business window (Monday to Friday, 9:00 to 12:00 and 13:00 to 17:00).',
});
export type PostureStatementKey = keyof typeof POSTURE_STATEMENTS;
export const POSTURE_STATEMENT_KEYS = Object.freeze(Object.keys(POSTURE_STATEMENTS) as PostureStatementKey[]);

/** Federal rules the business-to-business statement rests on. Read once, not per state. */
export const FEDERAL_CITATIONS: readonly PostureCitation[] = Object.freeze([
  Object.freeze({
    title:
      'Telemarketing Sales Rule, 16 CFR 310.6(b)(7): business-to-business calls are exempt, except from § 310.3(a)(2) (misrepresentation) and § 310.3(a)(4) (false or misleading statements)',
    url: 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.6',
    quote:
      'Telephone calls between a telemarketer and any business to induce the purchase of goods or services or a charitable contribution by the business, provided, however that this exemption does not apply to: (i) The requirements of § 310.3(a)(2) and(4); or (ii) Calls to induce the retail sale of nondurable office or cleaning supplies; provided, however, that §§ 310.4(b)(1)(iii)(B) and 310.5 shall not apply to sellers or telemarketers of nondurable office or cleaning supplies.',
  }),
  Object.freeze({
    title:
      'Telemarketing Sales Rule, 16 CFR 310.3(a)(4): the ban that still applies to business calls, beside § 310.3(a)(2) on misrepresenting material information',
    url: 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.3',
    quote:
      'Making a false or misleading statement to induce any person to pay for goods or services or to induce a charitable contribution.',
  }),
  Object.freeze({
    title:
      'FCC rules under the TCPA, 47 CFR 64.1200(c)(2): the National Do Not Call Registry protects residential subscribers',
    url: 'https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200',
    quote:
      'A residential telephone subscriber who has registered his or her telephone number on the national do-not-call registry of persons who do not wish to receive telephone solicitations that is maintained by the Federal Government.',
  }),
]);

export interface StatePostureRule {
  readonly state: UsStateCode;
  readonly name: string;
  readonly summary: string;
  readonly citation: PostureCitation;
  readonly furtherCitations: readonly PostureCitation[];
}

/**
 * Per-state rule summary and citation, in plain language. The founder verifies each
 * quoted passage at its linked source before confirming; the posture record stores
 * exactly this citation beside the state.
 */
export const STATE_POSTURE_RULES: Readonly<Record<'RI' | 'MA' | 'TX', StatePostureRule>> = Object.freeze({
  RI: Object.freeze({
    state: 'RI',
    name: 'Rhode Island',
    summary:
      'Rhode Island\'s Telephone Sales Solicitation Act reaches business calls: § 5-61-1 defines a telephone solicitation as a conversation encouraging "a person" to purchase goods or services, with no consumer limitation. Registration (§ 5-61-3, with the Department of Business Regulation, renewed yearly) attaches to a "telephonic seller" as defined in § 5-61-2(9) unless an exclusion in § 5-61-2(10) applies; none of the listed exclusions plainly covers a first-time business-to-business sale of a service, so record either your registration or the exclusion you rely on. The do-not-call duty (§ 5-61-3.5) covers residential, mobile and paging numbers, including a firm\'s listed number when it is a mobile line, and is met by maintaining your own do-not-call list under 47 C.F.R. Part 64 or 16 C.F.R. Part 310 (this app\'s suppression record). Hours of operation are in § 5-61-3.6.',
    citation: Object.freeze({
      title: 'R.I. Gen. Laws § 5-61-1, Telephone Sales Solicitation Act (definition of telephone solicitation)',
      url: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-1.htm',
      quote:
        '"Telephone solicitation" means the engagement of a telephone conversation for the purpose of encouraging a person to purchase personal property, investment opportunities, goods or services, or for the purpose of gathering information for sales solicitation.',
    }),
    furtherCitations: Object.freeze([
      Object.freeze({
        title: 'R.I. Gen. Laws § 5-61-3 (registration)',
        url: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-3.htm',
        quote:
          'Not less than ten (10) days prior to doing business in this state, a telephone sales solicitation operation or telephonic seller shall register with the department',
      }),
      Object.freeze({
        title: 'R.I. Gen. Laws § 5-61-3.5(a) (do not call lists)',
        url: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-3.5.htm',
        quote:
          'No salesperson or telephonic seller shall make, or cause to be made, any unsolicited telephonic sales calls to any residential, mobile, or telephonic-paging-device telephone number unless the salesperson or telephonic seller has instituted procedures for maintaining a list of persons who do not wish to receive telephonic sales calls made by or on behalf of that person, in compliance with 47 C.F.R. Part 64 or 16 C.F.R. Part 310.',
      }),
      Object.freeze({
        title: 'R.I. Gen. Laws chapter 5-61 index: § 5-61-2 definitions and exclusions, § 5-61-3.6 hours of operation',
        url: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/INDEX.htm',
        quote: '§ 5-61-2. Definitions. § 5-61-3. Registration. § 5-61-3.5. Do not call lists. § 5-61-3.6. Hours of operation.',
      }),
    ]),
  }),
  MA: Object.freeze({
    state: 'MA',
    name: 'Massachusetts',
    summary:
      'Massachusetts General Laws chapter 159C attaches its duties to calls to a "consumer" as defined in § 1: an individual resident of the Commonwealth who is a prospective recipient of consumer goods or services. The no-sales-solicitation-calls listing is § 2 and the calling restrictions, including no calls received between 8:00 p.m. and 8:00 a.m. at the consumer\'s location, are § 3. The chapter\'s index shows no telephone-solicitor registration provision (§ 5 concerns marketing-list compilations, § 5A disclosures). Confirm that a call to a firm\'s listed business number, offering a business service, is outside the § 1 consumer definition, and record where you read it.',
    citation: Object.freeze({
      title: 'M.G.L. c. 159C, § 1 (definitions), Telemarketing Solicitation',
      url: 'https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section1',
      quote: '"Consumer", an individual who is a resident of the commonwealth and a prospective recipient of consumer goods or services.',
    }),
    furtherCitations: Object.freeze([
      Object.freeze({
        title: 'M.G.L. c. 159C, § 2 (no sales solicitation calls listing)',
        url: 'https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section2',
        quote:
          'The office shall establish and maintain a no sales solicitation calls listing of consumers who do not wish to receive unsolicited telephonic sales calls.',
      }),
      Object.freeze({
        title: 'M.G.L. c. 159C, § 3 (limitations on unsolicited telephonic sales calls, including hours)',
        url: 'https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section3',
        quote: 'to be received between the hours of 8:00 p.m. and 8:00 a.m., local time, at the consumer\'s location',
      }),
    ]),
  }),
  TX: Object.freeze({
    state: 'TX',
    name: 'Texas',
    summary:
      'Two Texas chapters apply. Chapter 302 (registration): § 302.101 requires a registration certificate from the Secretary of State for a telephone solicitation to a purchaser located in Texas unless a subchapter B exemption (§§ 302.051 to 302.061) applies. The commercial-sales exemption in § 302.056 covers only purchasers who resell the item or use it in recycling, reuse, remanufacturing or manufacturing, so it does not cover a property management firm buying a service; record the exemption you rely on or your registration certificate. Chapter 304 (the Texas no-call list): § 304.004(3) excludes calls between a telemarketer and a business unless the business has said it does not want them, and § 304.002 defines a telemarketing call around consumer goods or services; a business\'s request to stop becomes a suppression record in this app.',
    citation: Object.freeze({
      title: 'Tex. Bus. & Com. Code § 302.101 (registration certificate required)',
      url: 'https://tcss.legis.texas.gov/resources/BC/htm/BC.302.htm#302.101',
      quote:
        'A seller may not make a telephone solicitation from a location in this state or to a purchaser located in this state unless the seller holds a registration certificate for the business location from which the telephone solicitation is made.',
    }),
    furtherCitations: Object.freeze([
      Object.freeze({
        title:
          'Tex. Bus. & Com. Code § 302.056 (exemption: certain commercial sales), one of the subchapter B exemptions §§ 302.051 to 302.061',
        url: 'https://tcss.legis.texas.gov/resources/BC/htm/BC.302.htm#302.056',
        quote:
          'This chapter does not apply to a sale in which the purchaser is a business that intends to: (1) resell the item purchased; or (2) use the item purchased in a recycling, reuse, remanufacturing, or manufacturing process.',
      }),
      Object.freeze({
        title: 'Tex. Bus. & Com. Code § 304.004(3) (chapter 304 does not apply to business-to-business calls)',
        url: 'https://tcss.legis.texas.gov/resources/BC/htm/BC.304.htm#304.004',
        quote:
          'This chapter does not apply to a call made: ... (3) between a telemarketer and a business, other than by a facsimile solicitation, unless the business has informed the telemarketer that the business does not wish to receive a telemarketing call from the telemarketer',
      }),
    ]),
  }),
});

// ---------------------------------------------------------------------------
// Posture applicability (specification 9.2, step 6)
// ---------------------------------------------------------------------------

export interface StatePostureRecord {
  readonly state: string;
  readonly revision: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly reviewAt: string;
  readonly revokedAt: string | null;
}

export type PostureDecision =
  | { readonly kind: 'applies'; readonly posture: StatePostureRecord }
  | { readonly kind: 'refused'; readonly reason: 'posture_missing' | 'posture_overlapping' };

/**
 * Exactly one applicable posture whose effective range contains database time. Zero or
 * several fail closed (Appendix G 25: "policy versions with zero, one, and two
 * applicable rows fail, allow, and fail").
 *
 * The review date no longer decides anything (wave 2, S4.2): a state on the "OK to call"
 * list stays on it until it is revoked, and a stored `review_at` that has passed is
 * read and ignored. `posture_overdue` is never answered.
 */
export function selectApplicablePosture(
  postures: readonly StatePostureRecord[],
  state: string,
  now: string,
): PostureDecision {
  const code = state.trim().toUpperCase();
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new TypeError('a posture decision is made at an ISO 8601 database time');

  const applicable = postures.filter(posture => {
    if (posture.state.trim().toUpperCase() !== code) return false;
    if (posture.revokedAt !== null) return false;
    const from = Date.parse(posture.effectiveFrom);
    if (!Number.isFinite(from) || from > at) return false;
    if (posture.effectiveTo === null) return true;
    const to = Date.parse(posture.effectiveTo);
    return Number.isFinite(to) && to > at;
  });

  if (applicable.length > 1) return { kind: 'refused', reason: 'posture_overlapping' };
  const only = applicable[0];
  if (only === undefined) return { kind: 'refused', reason: 'posture_missing' };
  return { kind: 'applies', posture: only };
}

/**
 * The `review_at` a new posture stores: one calendar year after it takes effect (same
 * UTC month, day and time). Written only because schema 18 requires the column and its
 * `state_postures_review_after_effective` CHECK until migration 0019; nothing reads it
 * for a decision since wave 2 (S4.2).
 */
export function postureReviewAt(confirmedAt: string): string {
  const parsed = Date.parse(confirmedAt);
  if (!Number.isFinite(parsed)) throw new TypeError('a posture confirmation is an ISO 8601 instant');
  const date = new Date(parsed);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}
