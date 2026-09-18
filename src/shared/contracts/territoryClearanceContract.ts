import { z } from 'zod';
import { accountInstantSchema as instant } from './accountContract';

/**
 * One compliance clearance per state (David's decision, 17 Sep 2026, design D4).
 * The founder confirms, once per state and with a citation, that the calls the
 * Mac places are business-to-business calls to listed business numbers, that
 * the state's registration status and do-not-call subscription status were
 * checked, and that the consent rule is accepted. Storage stays per state so a
 * single state can be revoked or re-confirmed. The Settings section renders the
 * statements and citations from this contract; the engineering note
 * `docs/engineering/territory-clearance.md` is the reading copy David edits
 * before confirming. Nothing in this contract dials, grants or sends.
 */

/** United States postal codes, the only jurisdiction vocabulary the clearance accepts. */
export const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;
export const territoryStateSchema = z.enum(US_STATE_CODES);
export type TerritoryState = z.infer<typeof territoryStateSchema>;

/** IANA zones a state clearance may carry. Every entry is a zone the Intl API resolves on macOS. */
export const TERRITORY_TIME_ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
] as const;
export const territoryTimeZoneSchema = z.enum(TERRITORY_TIME_ZONES);
export type TerritoryTimeZone = z.infer<typeof territoryTimeZoneSchema>;

/**
 * The fixed state map: the territory's states and the local time zone the
 * calling window uses for each. A firm whose Places address names a state that
 * is not listed here stays `jurisdiction_unknown` at authorization time; adding
 * a state to the territory means adding it here (and a rule entry below), after
 * which it appears in Settings as unconfirmed with the same one-click control.
 */
export const TERRITORY_STATE_TIME_ZONES = Object.freeze({
  RI: 'America/New_York',
  MA: 'America/New_York',
  TX: 'America/Chicago',
} as const satisfies Partial<Record<TerritoryState, TerritoryTimeZone>>);
export type TerritoryClearanceState = keyof typeof TERRITORY_STATE_TIME_ZONES;
export const TERRITORY_STATES = Object.freeze(Object.keys(TERRITORY_STATE_TIME_ZONES) as TerritoryClearanceState[]);
export const isTerritoryState = (value: string): value is TerritoryClearanceState => Object.hasOwn(TERRITORY_STATE_TIME_ZONES, value);

/** Bump when any statement, summary or citation text below changes; a stale renderer cannot confirm text it did not show. */
export const TERRITORY_RULES_REVISION = 2;

const httpsUrl = z.url().max(2048).refine(value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } }, 'Citations link to https sources only.');
export const territoryCitationSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  url: httpsUrl,
  quote: z.string().trim().min(1).max(600),
});
export type TerritoryCitation = z.infer<typeof territoryCitationSchema>;

/** The statements David confirms. Shown once above the state list; stored with every clearance row. */
export const TERRITORY_CLEARANCE_STATEMENTS = Object.freeze({
  businessToBusiness: 'These are business-to-business calls placed from my Mac to business numbers that each firm lists publicly for its own business (its Google Business Profile listing or its own website). No residential or personal number is dialed.',
  registrationStatusChecked: 'I have checked whether my business must register as a telephone solicitor or telemarketer in this state before placing these calls, and my registration status satisfies the rule quoted for the state.',
  stateDncSubscriptionChecked: 'I have checked whether this state requires a subscription to its do-not-call list for these calls, and my subscription status satisfies the rule quoted for the state.',
  consentRuleConfirmed: 'Consent is never assumed: a request to stop calling is honored at once and recorded, no number with a suppression record is dialed, and calls stay inside the recipient\'s local business window (Monday to Friday, 9:00 to 12:00 and 13:00 to 17:00).',
});
export type TerritoryClearanceStatementKey = keyof typeof TERRITORY_CLEARANCE_STATEMENTS;
export const TERRITORY_CLEARANCE_STATEMENT_KEYS = Object.freeze(Object.keys(TERRITORY_CLEARANCE_STATEMENTS) as TerritoryClearanceStatementKey[]);

/** Federal rules the business-to-business statement rests on. Read once, not per state. */
export const TERRITORY_FEDERAL_CITATIONS: readonly TerritoryCitation[] = Object.freeze([
  Object.freeze({
    title: 'Telemarketing Sales Rule, 16 CFR 310.6(b)(7): business-to-business calls are exempt, except from § 310.3(a)(2) (misrepresentation) and § 310.3(a)(4) (false or misleading statements)',
    url: 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.6',
    quote: 'Telephone calls between a telemarketer and any business to induce the purchase of goods or services or a charitable contribution by the business, provided, however that this exemption does not apply to: (i) The requirements of § 310.3(a)(2) and(4); or (ii) Calls to induce the retail sale of nondurable office or cleaning supplies; provided, however, that §§ 310.4(b)(1)(iii)(B) and 310.5 shall not apply to sellers or telemarketers of nondurable office or cleaning supplies.',
  }),
  Object.freeze({
    title: 'Telemarketing Sales Rule, 16 CFR 310.3(a)(4): the ban that still applies to business calls, beside § 310.3(a)(2) on misrepresenting material information',
    url: 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.3',
    quote: 'Making a false or misleading statement to induce any person to pay for goods or services or to induce a charitable contribution.',
  }),
  Object.freeze({
    title: 'FCC rules under the TCPA, 47 CFR 64.1200(c)(2): the National Do Not Call Registry protects residential subscribers',
    url: 'https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200',
    quote: 'A residential telephone subscriber who has registered his or her telephone number on the national do-not-call registry of persons who do not wish to receive telephone solicitations that is maintained by the Federal Government.',
  }),
]);

/** `citation` is the passage stored beside the confirmation; `furtherCitations` are the other sections David reads for the same state. */
export type TerritoryStateRule = Readonly<{ state: TerritoryClearanceState; name: string; summary: string; citation: TerritoryCitation; furtherCitations: readonly TerritoryCitation[] }>;
/**
 * Per-state rule summary and citation, in plain language. David verifies each
 * quoted passage at its linked source before confirming; the confirmation
 * records exactly this citation beside the state.
 */
export const TERRITORY_STATE_RULES: Readonly<Record<TerritoryClearanceState, TerritoryStateRule>> = Object.freeze({
  RI: Object.freeze({
    state: 'RI', name: 'Rhode Island',
    summary: 'Rhode Island\'s Telephone Sales Solicitation Act reaches business calls: § 5-61-1 defines a telephone solicitation as a conversation encouraging "a person" to purchase goods or services, with no consumer limitation. Registration (§ 5-61-3, with the Department of Business Regulation, renewed yearly) attaches to a "telephonic seller" as defined in § 5-61-2(9) unless an exclusion in § 5-61-2(10) applies; none of the listed exclusions plainly covers a first-time business-to-business sale of a service, so record either your registration or the exclusion you rely on. The do-not-call duty (§ 5-61-3.5) covers residential, mobile and paging numbers, including a firm\'s listed number when it is a mobile line, and is met by maintaining your own do-not-call list under 47 C.F.R. Part 64 or 16 C.F.R. Part 310 (this app\'s suppression record). Hours of operation are in § 5-61-3.6.',
    citation: Object.freeze({
      title: 'R.I. Gen. Laws § 5-61-1, Telephone Sales Solicitation Act (definition of telephone solicitation)',
      url: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-1.htm',
      quote: '"Telephone solicitation" means the engagement of a telephone conversation for the purpose of encouraging a person to purchase personal property, investment opportunities, goods or services, or for the purpose of gathering information for sales solicitation.',
    }),
    furtherCitations: Object.freeze([
      Object.freeze({
        title: 'R.I. Gen. Laws § 5-61-3 (registration)',
        url: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-3.htm',
        quote: 'Not less than ten (10) days prior to doing business in this state, a telephone sales solicitation operation or telephonic seller shall register with the department',
      }),
      Object.freeze({
        title: 'R.I. Gen. Laws § 5-61-3.5(a) (do not call lists)',
        url: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-3.5.htm',
        quote: 'No salesperson or telephonic seller shall make, or cause to be made, any unsolicited telephonic sales calls to any residential, mobile, or telephonic-paging-device telephone number unless the salesperson or telephonic seller has instituted procedures for maintaining a list of persons who do not wish to receive telephonic sales calls made by or on behalf of that person, in compliance with 47 C.F.R. Part 64 or 16 C.F.R. Part 310.',
      }),
      Object.freeze({
        title: 'R.I. Gen. Laws chapter 5-61 index: § 5-61-2 definitions and exclusions, § 5-61-3.6 hours of operation',
        url: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/INDEX.htm',
        quote: '§ 5-61-2. Definitions. § 5-61-3. Registration. § 5-61-3.5. Do not call lists. § 5-61-3.6. Hours of operation.',
      }),
    ]),
  }),
  MA: Object.freeze({
    state: 'MA', name: 'Massachusetts',
    summary: 'Massachusetts General Laws chapter 159C attaches its duties to calls to a "consumer" as defined in § 1: an individual resident of the Commonwealth who is a prospective recipient of consumer goods or services. The no-sales-solicitation-calls listing is § 2 and the calling restrictions, including no calls received between 8:00 p.m. and 8:00 a.m. at the consumer\'s location, are § 3. The chapter\'s index shows no telephone-solicitor registration provision (§ 5 concerns marketing-list compilations, § 5A disclosures). Confirm that a call to a firm\'s listed business number, offering a business service, is outside the § 1 consumer definition, and record where you read it.',
    citation: Object.freeze({
      title: 'M.G.L. c. 159C, § 1 (definitions), Telemarketing Solicitation',
      url: 'https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section1',
      quote: '"Consumer", an individual who is a resident of the commonwealth and a prospective recipient of consumer goods or services.',
    }),
    furtherCitations: Object.freeze([
      Object.freeze({
        title: 'M.G.L. c. 159C, § 2 (no sales solicitation calls listing)',
        url: 'https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section2',
        quote: 'The office shall establish and maintain a no sales solicitation calls listing of consumers who do not wish to receive unsolicited telephonic sales calls.',
      }),
      Object.freeze({
        title: 'M.G.L. c. 159C, § 3 (limitations on unsolicited telephonic sales calls, including hours)',
        url: 'https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section3',
        quote: 'to be received between the hours of 8:00 p.m. and 8:00 a.m., local time, at the consumer\'s location',
      }),
    ]),
  }),
  TX: Object.freeze({
    state: 'TX', name: 'Texas',
    summary: 'Two Texas chapters apply. Chapter 302 (registration): § 302.101 requires a registration certificate from the Secretary of State for a telephone solicitation to a purchaser located in Texas unless a subchapter B exemption (§§ 302.051 to 302.061) applies. The commercial-sales exemption in § 302.056 covers only purchasers who resell the item or use it in recycling, reuse, remanufacturing or manufacturing, so it does not cover a property management firm buying a service; record the exemption you rely on or your registration certificate. Chapter 304 (the Texas no-call list): § 304.004(3) excludes calls between a telemarketer and a business unless the business has said it does not want them, and § 304.002 defines a telemarketing call around consumer goods or services; a business\'s request to stop becomes a suppression record in this app.',
    citation: Object.freeze({
      title: 'Tex. Bus. & Com. Code § 302.101 (registration certificate required)',
      url: 'https://tcss.legis.texas.gov/resources/BC/htm/BC.302.htm#302.101',
      quote: 'A seller may not make a telephone solicitation from a location in this state or to a purchaser located in this state unless the seller holds a registration certificate for the business location from which the telephone solicitation is made.',
    }),
    furtherCitations: Object.freeze([
      Object.freeze({
        title: 'Tex. Bus. & Com. Code § 302.056 (exemption: certain commercial sales), one of the subchapter B exemptions §§ 302.051 to 302.061',
        url: 'https://tcss.legis.texas.gov/resources/BC/htm/BC.302.htm#302.056',
        quote: 'This chapter does not apply to a sale in which the purchaser is a business that intends to: (1) resell the item purchased; or (2) use the item purchased in a recycling, reuse, remanufacturing, or manufacturing process.',
      }),
      Object.freeze({
        title: 'Tex. Bus. & Com. Code § 304.004(3) (chapter 304 does not apply to business-to-business calls)',
        url: 'https://tcss.legis.texas.gov/resources/BC/htm/BC.304.htm#304.004',
        quote: 'This chapter does not apply to a call made: ... (3) between a telemarketer and a business, other than by a facsimile solicitation, unless the business has informed the telemarketer that the business does not wish to receive a telemarketing call from the telemarketer',
      }),
    ]),
  }),
});

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const territoryClearanceStatementsSchema = z.strictObject({
  businessToBusiness: z.literal(true),
  registrationStatusChecked: z.literal(true),
  stateDncSubscriptionChecked: z.literal(true),
  consentRuleConfirmed: z.literal(true),
  rulesRevision: z.number().int().positive(),
});
export type TerritoryClearanceStatements = z.infer<typeof territoryClearanceStatementsSchema>;

const territoryClearanceRowSchema = z.strictObject({
  state: territoryStateSchema,
  revision,
  timezone: territoryTimeZoneSchema,
  statements: territoryClearanceStatementsSchema,
  citation: territoryCitationSchema,
  confirmedAt: instant,
  reviewAt: instant,
  revokedAt: instant.nullable(),
});
/** One stored clearance row. `revision` increases on every confirm and revoke. */
export const territoryClearanceSchema = territoryClearanceRowSchema.refine(value => value.reviewAt > value.confirmedAt, 'Review date must follow the confirmation.');
export type TerritoryClearance = z.infer<typeof territoryClearanceSchema>;
/** The fields the authorization read needs; the texts stay in the row. */
export const territoryClearanceRecordSchema = territoryClearanceRowSchema.pick({ state: true, revision: true, timezone: true, confirmedAt: true, reviewAt: true, revokedAt: true })
  .refine(value => value.reviewAt > value.confirmedAt, 'Review date must follow the confirmation.');
export type TerritoryClearanceRecord = z.infer<typeof territoryClearanceRecordSchema>;

export const territoryStateStatusSchema = z.enum(['unconfirmed', 'confirmed', 'review_due', 'revoked']);
export type TerritoryStateStatus = z.infer<typeof territoryStateStatusSchema>;
export const territoryStateViewSchema = z.strictObject({
  state: territoryStateSchema,
  name: z.string().trim().min(1).max(100),
  timezone: territoryTimeZoneSchema,
  status: territoryStateStatusSchema,
  clearance: territoryClearanceSchema.nullable(),
});
export type TerritoryStateView = z.infer<typeof territoryStateViewSchema>;

export const territoryClearanceSnapshotSchema = z.strictObject({
  generatedAt: instant,
  rulesRevision: z.literal(TERRITORY_RULES_REVISION),
  /** Territory states first in map order, then any stored state no longer in the territory (still revocable). */
  states: z.array(territoryStateViewSchema).min(1).max(US_STATE_CODES.length),
}).refine(value => new Set(value.states.map(entry => entry.state)).size === value.states.length, 'One row per state.');
export type TerritoryClearanceSnapshot = z.infer<typeof territoryClearanceSnapshotSchema>;

/** The one click: confirm every listed state at once. Storage still writes one row per state. */
export const confirmTerritoryClearanceSchema = z.strictObject({
  states: z.array(territoryStateSchema).min(1).max(US_STATE_CODES.length).refine(states => new Set(states).size === states.length, 'Duplicate state.'),
  disclosureAccepted: z.literal(true),
  rulesRevision: z.literal(TERRITORY_RULES_REVISION),
});
export type ConfirmTerritoryClearance = z.infer<typeof confirmTerritoryClearanceSchema>;

export const revokeTerritoryClearanceSchema = z.strictObject({
  state: territoryStateSchema,
  expectedRevision: revision,
});
export type RevokeTerritoryClearance = z.infer<typeof revokeTerritoryClearanceSchema>;

/** Review falls due one calendar year after confirmation (same UTC month, day and time). */
export function territoryReviewAt(confirmedAt: string): string {
  const date = new Date(instant.parse(confirmedAt));
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}

export function territoryStateStatus(clearance: TerritoryClearance | null, now: string): TerritoryStateStatus {
  if (!clearance) return 'unconfirmed';
  if (clearance.revokedAt !== null) return 'revoked';
  return clearance.reviewAt <= now ? 'review_due' : 'confirmed';
}

/** The hold text Today shows on the Call control when a firm's state has no usable clearance. */
export function territoryHoldMessage(hold: { reason: 'state_clearance_missing' | 'jurisdiction_unknown'; state: string | null }): string {
  if (hold.reason === 'state_clearance_missing' && hold.state) return `Held: no clearance confirmed for ${hold.state}`;
  return 'Held: this firm\'s state could not be read from its listing';
}
