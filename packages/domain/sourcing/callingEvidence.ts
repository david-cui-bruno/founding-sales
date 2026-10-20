import {createHash} from 'node:crypto';
import {qualificationEvidenceSchema, sourceObservationSchema, type QualificationFact, type SourceObservation} from '@fss/contracts';
import type {QualificationCandidateContext} from './qualificationCitationRoles.ts';
import {canonicalizePhone} from '../src/rules/suppressionCanonicalization.ts';
import {isDiscoveryDirectory} from './discoveryIdentity.ts';

/** Calling evidence only. This version grants no admission, email/SMS or call authority. */
export const CALLING_EVIDENCE_POLICY_VERSION = 'calling-first-party-tx-v1';
export type CallingEvidenceRule = 'positive_firm_identity' | 'phone_anywhere_first_party'
  | 'texas_anywhere_first_party' | 'residential_rentals_anywhere_first_party';
export interface CallingEvidenceAudit {
  rule: CallingEvidenceRule;
  observationId: string;
  blockId: string;
  url: string;
  contentHash: string;
  relevantTextHash: string;
  retrievedAt: string;
  value: string;
}
export interface CallingEvidenceInput {
  candidate: QualificationCandidateContext;
  observations: readonly SourceObservation[];
  facts: readonly QualificationFact[];
  phone: string | null;
  /** Explicit unknown is held, not silently interpreted as a nonpersonal number. */
  knownPersonalCell: boolean | null;
  now: string;
}
export type CallingEvidenceAssessment = {
  policyVersion: typeof CALLING_EVIDENCE_POLICY_VERSION;
  audit: CallingEvidenceAudit[];
} & ({kind: 'source_evidence_eligible'; reason: null; phone: string; expiresAt: string}
  | {kind: 'held'; reason: string});

const ageLimit = 7 * 24 * 60 * 60 * 1000;
const fold = (text: string) => text.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
const literal = (text: string, value: string) => ` ${fold(text)} `.includes(` ${fold(value)} `);
const attributed = /\b(?:powered by|website by|web design|testimonial|customer review|vendor|partner|supplier|contractor|referral|police|fire department|emergency services)\b/iu;
const texasCities = ['Dallas', 'Fort Worth', 'DFW', 'Arlington', 'Plano', 'Frisco', 'Denton', 'Irving', 'McKinney', 'Garland', 'Mesquite', 'Richardson', 'Lewisville', 'Carrollton', 'Allen', 'Grand Prairie', 'Austin', 'Houston', 'San Antonio', 'El Paso'];
const foreignState = /\b(?:AK|AL|AR|AZ|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|UT|VA|VT|WA|WI|WV|WY)\s+\d{5}\b|,\s*(?:GA|MN|CA|RI|MA|FL|NY|OK|NM)\b/u;
const phonePattern = /(?<![\p{L}\d])(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}(?![\p{L}\d])/gu;
const negative = /\b(?:not|never|no longer|do not|does not|don['’]t|doesn['’]t|outside|except|excluding|formerly|previously|used to)\b/iu;
function host(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      ? url.hostname.toLowerCase().replace(/^www\./u, '') : null;
  } catch { return null; }
}
const identityProduction = (text: string, name: string) => !negative.test(text) && !attributed.test(text)
  && (fold(text).startsWith(`${fold(name)} `) || fold(text) === fold(name)
    || fold(text).startsWith(`we are ${fold(name)} `) || fold(text) === `we are ${fold(name)}`);
function numbers(text: string): string[] {
  return [...new Set([...text.matchAll(phonePattern)].flatMap(match => {
    const result = canonicalizePhone(match[0]);
    return result.ok ? [result.handle.value] : [];
  }))];
}
/** Same exact-endpoint adverse-label rule as the existing handoff guard. */
export function hasKnownPersonalPhoneEvidence(observations: readonly SourceObservation[], e164: string): boolean {
  if (observations.some(source => !sourceObservationSchema.safeParse(source).success)) return true;
  const matches = (text: string) => [...text.matchAll(/(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}/gu)].some(match => {
    const normalized = canonicalizePhone(match[0]);
    return normalized.ok && normalized.handle.value === e164;
  });
  return observations.some(source => source.blocks.some((block, index) => matches(block.text)
    && source.blocks.slice(Math.max(0, index - 1), index + 2).some(nearby => /\b(?:personal|cell|mobile)\b/iu.test(nearby.text))));
}
function deniesResidential(text: string): boolean {
  return /\b(?:do\s+not|does\s+not|don['’]t|doesn['’]t|never|no\s+longer)\s+(?:\w+\s+){0,3}(?:manage|offer|provide|handle|speciali[sz]e|rent|lease)\b[^.!?\n]{0,120}\b(?:residential|homes|houses|apartments|residences|rentals|single.family|multi.family)\b/iu.test(text)
    || /\b(?:commercial|industrial)\b[^.!?\n]{0,80}\b(?:only|exclusively)\b|\b(?:only|exclusively)\b[^.!?\n]{0,80}\b(?:commercial|industrial)\b/iu.test(text);
}

/** All input sources are checked, including unselected adverse blocks. Fact labels
 * cannot manufacture proof. Output is advisory until normal runtime safety passes. */
export function assessCallingEvidence(input: CallingEvidenceInput): CallingEvidenceAssessment {
  const audit: CallingEvidenceAudit[] = [];
  const held = (reason: string): CallingEvidenceAssessment => ({kind: 'held', policyVersion: CALLING_EVIDENCE_POLICY_VERSION, reason, audit});
  const now = Date.parse(input.now), expectedHost = host(input.candidate.website);
  if (!Number.isFinite(now) || !expectedHost || !qualificationEvidenceSchema.safeParse({observations: input.observations, facts: input.facts}).success
    || !input.observations.length || Buffer.byteLength(JSON.stringify(input.observations)) > 100_000
    || Buffer.byteLength(JSON.stringify(input.facts)) > 50_000) return held('invalid_evidence');
  if (input.observations.some(source => !source.firstParty || source.truncated || host(source.url) !== expectedHost
    || createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex') !== source.relevantTextHash
    || Date.parse(source.retrievedAt) > now || now >= Date.parse(source.retrievedAt) + ageLimit)) return held('source_incomplete_or_unverified');
  if (input.knownPersonalCell !== false) return held(input.knownPersonalCell ? 'known_personal_cell' : 'personal_cell_unknown');
  const phoneNumber = input.phone;
  if (typeof phoneNumber !== 'string') return held('invalid_phone');
  const normalized = canonicalizePhone(phoneNumber);
  if (!normalized.ok || normalized.handle.value !== phoneNumber) return held('invalid_phone');
  if (input.candidate.region !== 'TX' || isDiscoveryDirectory(input.candidate.website)) return held('identity_unresolved');
  const name = fold(input.candidate.firmName);
  if (name.length < 4 || /^(?:property management|property manager|rentals|home|contact|about us)$/u.test(name)) return held('identity_unresolved');
  const blocks = input.observations.flatMap(source => source.blocks.map((block, index) => ({source, block, index})));
  const selectedIdentities = input.facts.filter(fact => fact.kind === 'firm_identity');
  // Strict extraction may have refused unrelated roles. Independently recover
  // only affirmative exact-name blocks, preserving literal source-owned values.
  const identities = selectedIdentities.length ? selectedIdentities : blocks.filter(({block}) => identityProduction(block.text, input.candidate.firmName))
    .map(({source, block}): QualificationFact => ({kind: 'firm_identity', observationId: source.id, blockId: block.id, value: block.text}));
  if (!identities.length || identities.some(fact => !literal(fact.value, input.candidate.firmName) || !identityProduction(fact.value, input.candidate.firmName)
    || !identityProduction(blocks.find(item => item.source.id === fact.observationId && item.block.id === fact.blockId)!.block.text, input.candidate.firmName))) return held('firm_identity_ambiguous');
  const add = (rule: CallingEvidenceRule, item: typeof blocks[number]) => audit.push({rule, observationId: item.source.id, blockId: item.block.id,
    url: item.source.url, contentHash: item.source.contentHash, relevantTextHash: item.source.relevantTextHash, retrievedAt: item.source.retrievedAt, value: item.block.text});
  const identity = identities[0]!;
  add('positive_firm_identity', blocks.find(item => item.source.id === identity.observationId && item.block.id === identity.blockId)!);
  const occurrences = blocks.filter(item => numbers(item.block.text).includes(phoneNumber));
  if (!occurrences.length) return held('phone_not_on_first_party_site');
  if (hasKnownPersonalPhoneEvidence(input.observations, phoneNumber)) return held('known_personal_cell');
  // An adverse exact-endpoint association wins even when a clean contact block exists.
  if (occurrences.some(({block}) => attributed.test(block.text) || /\b(?:fax|emergency|after.hours|agent|realtor)\b/iu.test(block.text))) return held('phone_association_ambiguous');
  // Phone presence anywhere is sufficient unless retained source context gives
  // concrete contrary attribution. No contact-line or same-name-block grammar.
  if (occurrences.some(({source, index}) => source.blocks.slice(Math.max(0, index - 1), index + 2).some(nearby => attributed.test(nearby.text) || foreignState.test(nearby.text)
    || (!literal(nearby.text, input.candidate.firmName) && /^(?:other|another)\b/iu.test(nearby.text))))) return held('phone_association_ambiguous');
  const phone = occurrences[0]!;
  add('phone_anywhere_first_party', phone);
  if (blocks.some(({block}) => /\b(?:Texas|TX)\b/u.test(block.text) && /\b(?:do not|does not|don['’]t|doesn['’]t|never|no longer)\s+(?:\w+\s+){0,3}(?:serve|operate|manage|cover)\b/iu.test(block.text))) return held('texas_conflicts');
  const texas = blocks.find(({block}) => !attributed.test(block.text) && !negative.test(block.text)
    && !foreignState.test(block.text) && (/\b(?:Texas|TX)\b/iu.test(block.text) || texasCities.some(city => literal(block.text, city))));
  if (!texas) return held('texas_unproven');
  add('texas_anywhere_first_party', texas);
  if (blocks.some(({block}) => deniesResidential(block.text))) return held('residential_fit_conflicts');
  const management = blocks.find(({block}) => !attributed.test(block.text) && !negative.test(block.text) && /\b(?:manage|manages|managing|rentals?|leasing|for rent)\b/iu.test(block.text))
    ?? blocks.find(({block}) => !attributed.test(block.text) && !negative.test(block.text) && /\bproperty management\b/iu.test(block.text));
  const residential = blocks.find(({block}) => !attributed.test(block.text) && !negative.test(block.text)
    && /\b(?:residential|homes|houses|apartments|residences|rentals|single.family|multi.family|multifamily)\b/iu.test(block.text));
  if (!management || !residential) return held('residential_rentals_unproven');
  add('residential_rentals_anywhere_first_party', residential);
  if (management.block.id !== residential.block.id || management.source.id !== residential.source.id) add('residential_rentals_anywhere_first_party', management);
  return {kind: 'source_evidence_eligible', policyVersion: CALLING_EVIDENCE_POLICY_VERSION, reason: null, audit, phone: phoneNumber,
    expiresAt: new Date(Math.min(...input.observations.map(source => Date.parse(source.retrievedAt) + ageLimit))).toISOString()};
}
