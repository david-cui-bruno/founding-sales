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
export const TERRITORY_RULES_REVISION = 1;

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
    title: 'Telemarketing Sales Rule, 16 CFR 310.6(b)(7): business-to-business calls',
    url: 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.6',
    quote: 'Telephone calls between a telemarketer and any business to induce the purchase of goods or services or a charitable contribution by the business, except calls to induce the retail sale of nondurable office or cleaning supplies',
  }),
  Object.freeze({
    title: 'FCC rules under the TCPA, 47 CFR 64.1200(c)(2): the National Do Not Call Registry protects residential subscribers',
    url: 'https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200',
    quote: 'A residential telephone subscriber who has registered his or her telephone number on the national do-not-call registry of persons who do not wish to receive telephone solicitations that is maintained by the Federal Government.',
  }),
]);

export type TerritoryStateRule = Readonly<{ state: TerritoryClearanceState; name: string; summary: string; citation: TerritoryCitation }>;
/**
 * Per-state rule summary and citation, in plain language. David verifies each
 * quoted passage at its linked source before confirming; the confirmation
 * records exactly this citation beside the state.
 */
export const TERRITORY_STATE_RULES: Readonly<Record<TerritoryClearanceState, TerritoryStateRule>> = Object.freeze({
  RI: Object.freeze({
    state: 'RI', name: 'Rhode Island',
    summary: 'Rhode Island\'s Telephone Sales Solicitation Act (R.I. Gen. Laws chapter 5-61) defines a telephonic sales call as a call to a consumer for consumer goods or services, and its registration and no-call duties attach to those calls. Confirm that a call to a property management firm\'s listed business number, offering a business service, is outside that definition, and record where you read it.',
    citation: Object.freeze({
      title: 'R.I. Gen. Laws § 5-61-1 (definitions), Telephone Sales Solicitation Act',
      url: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-1.htm',
      quote: '"Telephonic sales call" means a call made by a telephone solicitor to a consumer, for the purpose of soliciting a sale of any consumer goods or services',
    }),
  }),
  MA: Object.freeze({
    state: 'MA', name: 'Massachusetts',
    summary: 'Massachusetts General Laws chapter 159C defines a consumer as a resident of the Commonwealth who is a prospective recipient of consumer goods or services, and its do-not-call list, registration and calling-hour duties attach to telephonic sales calls to consumers. Confirm that a call to a firm\'s listed business number, offering a business service, is outside that definition, and record where you read it.',
    citation: Object.freeze({
      title: 'M.G.L. c. 159C, § 1 (definitions), Telemarketing Solicitation',
      url: 'https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section1',
      quote: '"Consumer", an individual who is a resident of the commonwealth and a prospective recipient of consumer goods or services.',
    }),
  }),
  TX: Object.freeze({
    state: 'TX', name: 'Texas',
    summary: 'Texas Business & Commerce Code chapter 302 requires a registration certificate for telephone solicitations to purchasers in Texas unless an exemption in subchapter B applies, and chapter 304 keeps the Texas no-call list for telemarketing calls to consumers. Confirm which chapter 302 exemption covers your calls to a firm\'s listed business number (or that you hold the certificate), confirm the chapter 304 position for business numbers, and record where you read it.',
    citation: Object.freeze({
      title: 'Tex. Bus. & Com. Code § 302.101 (registration certificate required), with the subchapter B exemptions',
      url: 'https://statutes.capitol.texas.gov/Docs/BC/htm/BC.302.htm',
      quote: 'A seller may not make a telephone solicitation from a location in this state or to a purchaser located in this state unless the seller holds a registration certificate for the business location from which the telephone solicitation is made.',
    }),
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
