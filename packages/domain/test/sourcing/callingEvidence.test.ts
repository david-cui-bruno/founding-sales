import {createHash, randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import type {QualificationFact, SourceObservation} from '@fss/contracts';
import {assessCallingEvidence, CALLING_EVIDENCE_POLICY_VERSION, type CallingEvidenceInput} from '../../sourcing/callingEvidence.ts';

const now = '2026-10-20T12:30:00.000Z';
const candidate = {firmName: 'Northwind Property Management', website: 'https://northwind.example.test', locality: 'Dallas', region: 'TX' as const};
function source(texts: string[], path = '/'): SourceObservation {
  const blocks = texts.map((text, index) => ({id: `b${index}`, text}));
  return {id: randomUUID(), url: `${candidate.website}${path}`, contentHash: 'a'.repeat(64),
    relevantTextHash: createHash('sha256').update(JSON.stringify(blocks)).digest('hex'), retrievedAt: now,
    publishedAt: null, publishedAtBlockId: null, firstParty: true, truncated: false, blocks};
}
function fixture(texts?: string[]): CallingEvidenceInput {
  const observation = source(texts ?? [candidate.firmName, 'We manage residential rental homes.', 'Dallas, TX', 'Phone: 817-555-0101']);
  const first = observation.blocks[0]!;
  const fact: QualificationFact = {kind: 'firm_identity', observationId: observation.id, blockId: first.id, value: first.text};
  return {candidate, observations: [observation], facts: [fact], phone: '+18175550101', knownPersonalCell: false, now};
}
const assess = (input = fixture()) => assessCallingEvidence(input);
const reason = (input: CallingEvidenceInput) => {
  const result = assess(input);
  expect(result.kind).toBe('held');
  return result.reason;
};

describe('calling-only first-party Texas policy', () => {
  it('accepts a plain phone separated from firm name and office address', () => {
    const result = assess();
    expect(result.kind).toBe('source_evidence_eligible');
    expect(result.policyVersion).toBe(CALLING_EVIDENCE_POLICY_VERSION);
    expect(result.audit.map(entry => entry.rule)).toEqual(['positive_firm_identity', 'phone_anywhere_first_party', 'texas_anywhere_first_party', 'residential_rentals_anywhere_first_party']);
    expect(result).not.toHaveProperty('callable');
    expect(result).not.toHaveProperty('admission');
    expect(result).not.toHaveProperty('sending');
  });
  it('accepts a firm-named phone production without changing phone punctuation', () => {
    expect(assess(fixture([candidate.firmName, 'Texas residential rentals', `${candidate.firmName}: (817) 555-0101`])).kind).toBe('source_evidence_eligible');
  });
  it.each(['Call us at 817-555-0101 to discuss your rental home.', '123 Main Street, Dallas, TX 75201 | 817-555-0101 | All rights reserved.', 'Questions about our services? Our team is available at 817-555-0101.'])('accepts an anywhere-site phone in benign prose or footer: %s', text => {
    expect(assess(fixture([candidate.firmName, 'We manage homes.', 'Dallas', text])).kind).toBe('source_evidence_eligible');
  });
  it.each(['Dallas', 'Austin', 'San Antonio', 'Houston', 'El Paso'])('accepts source-grounded supported Texas city without requiring a state label: %s', city => {
    expect(assess(fixture([candidate.firmName, 'Residential rentals', `Serving ${city}`, '817-555-0101'])).kind).toBe('source_evidence_eligible');
  });
  it('holds explicit contrary phone-branch geography rather than borrowing a Texas page', () => {
    expect(reason(fixture([candidate.firmName, 'Texas residential rentals', 'Dallas, GA 30132', '817-555-0101']))).toBe('phone_association_ambiguous');
  });
  it('allows phone, identity, Texas and residential facts on different complete pages', () => {
    const input = fixture([candidate.firmName]);
    input.observations = [...input.observations, source(['Office: 817.555.0101'], '/contact'), source(['Serving Texas'], '/areas'), source(['Available apartments for rent'], '/rentals')];
    const result = assess(input);
    expect(result.kind).toBe('source_evidence_eligible');
    expect(new Set(result.audit.map(entry => entry.observationId)).size).toBe(4);
    for (const entry of result.audit) {
      const observation = input.observations.find(value => value.id === entry.observationId)!;
      expect(entry.value).toBe(observation.blocks.find(block => block.id === entry.blockId)!.text);
      expect(entry.url).toBe(observation.url);
      expect(entry.relevantTextHash).toBe(observation.relevantTextHash);
    }
  });
  it('does not require an exact supported office city or street address', () => {
    const input = fixture([candidate.firmName, 'We manage single-family residences.', 'Serving Texas', '817-555-0101']);
    input.candidate = {...candidate, locality: 'Mansfield'};
    expect(assess(input).kind).toBe('source_evidence_eligible');
  });
  it.each(['Our rental homes', 'Apartments for lease', 'Multifamily property management', 'We manage residences'])('accepts approved residential vocabulary: %s', text => {
    expect(assess(fixture([candidate.firmName, text, 'Texas', '817-555-0101'])).kind).toBe('source_evidence_eligible');
  });
  it.each([true, null] as const)('holds explicit personal-cell status %s', knownPersonalCell => {
    expect(reason({...fixture(), knownPersonalCell})).toBe(knownPersonalCell ? 'known_personal_cell' : 'personal_cell_unknown');
  });
  it.each([
    ['Mobile: 817-555-0101'], ['Personal', '817-555-0101'], ['817-555-0101', 'Cell'],
  ].map(phoneBlocks => ({phoneBlocks})))('holds adverse personal evidence anywhere for selected endpoint: $phoneBlocks', ({phoneBlocks}) => {
    expect(reason(fixture([candidate.firmName, 'Texas residential property management', ...phoneBlocks]))).toBe('known_personal_cell');
  });
  it.each([
    ['Website by Other Firm 817-555-0101'], ['Fax: 817-555-0101'], ['Emergency: 817-555-0101'],
    ['Other Realty', '817-555-0101'], ['Vendor', '817-555-0101'], ['Other Firm: 817-555-0101'],
  ].map(phoneBlocks => ({phoneBlocks})))('refuses contaminated or nonoffice productions $phoneBlocks', ({phoneBlocks}) => {
    expect(reason(fixture([candidate.firmName, 'We manage residential homes in Texas.', ...phoneBlocks]))).toBe('phone_association_ambiguous');
  });
  it('does not discard adverse exact-endpoint evidence to accept a clean occurrence', () => {
    const input = fixture();
    input.observations = [...input.observations, source(['Mobile: 817-555-0101'], '/team')];
    expect(reason(input)).toBe('known_personal_cell');
  });
  it('does not contaminate selected office line from an unrelated personal endpoint', () => {
    const input = fixture();
    input.observations = [...input.observations, source(['Mobile: 512-555-0102'], '/team')];
    expect(assess(input).kind).toBe('source_evidence_eligible');
  });
  it('requires exact selected number, not another site number or normalization guess', () => {
    expect(reason({...fixture(), phone: '+15125550102'})).toBe('phone_not_on_first_party_site');
    expect(reason({...fixture(), phone: '817-555-0101'})).toBe('invalid_phone');
    expect(reason({...fixture(), phone: null})).toBe('invalid_phone');
  });
  it.each([
    {firstParty: false}, {truncated: true}, {url: 'https://other.example.test'},
    {retrievedAt: '2026-10-20T12:30:01.000Z'}, {retrievedAt: '2026-10-13T12:30:00.000Z'},
    {relevantTextHash: 'f'.repeat(64)},
  ])('checks every unselected source, never a favorable subset %#', patch => {
    const input = fixture();
    input.observations = [...input.observations, {...source(['Unselected footer'], '/footer'), ...patch}];
    expect(reason(input)).toBe('source_incomplete_or_unverified');
  });
  it('refuses invented facts and model labels rather than interpreting them as proof', () => {
    const input = fixture();
    input.facts = input.facts.map(fact => ({...fact, value: 'Invented Northwind Property Management'}));
    expect(reason(input)).toBe('invalid_evidence');
    input.facts = [];
    expect(assess(input).kind).toBe('source_evidence_eligible');
    expect(assess(input).audit[0]?.value).toBe(candidate.firmName);
  });
  it('accepts a grounded identity substring and audits its unchanged source block', () => {
    const input = fixture([`${candidate.firmName} serves Texas residential rentals.`, '817-555-0101']);
    input.facts = input.facts.map(fact => ({...fact, value: candidate.firmName}));
    expect(assess(input).kind).toBe('source_evidence_eligible');
    expect(assess(input).audit[0]?.value).toBe(input.observations[0]?.blocks[0]?.text);
  });
  it('refuses contrary identities and attributed firm names', () => {
    const input = fixture();
    input.candidate = {...candidate, firmName: 'Other Firm'};
    expect(reason(input)).toBe('firm_identity_ambiguous');
    expect(reason(fixture([`Customer review: ${candidate.firmName}`, 'Texas residential property management', '817-555-0101']))).toBe('firm_identity_ambiguous');
  });
  it.each(['We do not manage residential properties.', 'We never manage residences.', 'Commercial property management only.'])('refuses unselected contrary fit %s', text => {
    const input = fixture();
    input.observations = [...input.observations, source([text], '/services')];
    expect(reason(input)).toBe('residential_fit_conflicts');
  });
  it('does not convert commercial-only or sale-only homes into residential rentals', () => {
    expect(reason(fixture([candidate.firmName, 'Commercial leasing', 'Texas', '817-555-0101']))).toBe('residential_rentals_unproven');
    expect(reason(fixture([candidate.firmName, 'Homes for sale in Texas', '817-555-0101']))).toBe('residential_rentals_unproven');
  });
  it.each(['Residential homes for sale only', 'Residential homes'])('does not borrow commercial leasing for a consistently identified residential offering: %s', offering => {
    const name = 'Northwind Real Estate';
    const input = fixture([name, 'Commercial leasing', offering, 'Dallas, TX', '817-555-0101']);
    input.candidate = {...candidate, firmName: name};
    input.facts = [];
    const result = assess(input);
    expect(result).toMatchObject({kind: 'held', reason: 'residential_rentals_unproven'});
    expect(result.audit.map(entry => entry.rule)).toEqual(['positive_firm_identity', 'phone_anywhere_first_party', 'texas_anywhere_first_party']);
  });
  it('retains explicit cross-page rentals even alongside separate commercial leasing and residential sales', () => {
    const name = 'Northwind Real Estate';
    const input = fixture([name, 'Dallas, TX', '817-555-0101']);
    input.candidate = {...candidate, firmName: name};
    input.facts = [];
    input.observations = [...input.observations, source(['Commercial leasing'], '/commercial'), source(['Residential homes for sale only'], '/sales'), source(['Available apartments for rent'], '/rentals')];
    const result = assess(input);
    expect(result.kind).toBe('source_evidence_eligible');
    expect(result.audit.filter(entry => entry.rule === 'residential_rentals_anywhere_first_party').map(entry => entry.url)).toEqual([`${candidate.website}/rentals`]);
  });
  it('retains residential management vocabulary grounded across different pages', () => {
    const input = fixture([candidate.firmName, 'Dallas', '817-555-0101']);
    input.observations = [...input.observations, source(['Property management services'], '/services'), source(['Residential homes'], '/homes')];
    expect(assess(input).kind).toBe('source_evidence_eligible');
  });
  it('does not use candidate Texas region or ambiguous city alone as source proof', () => {
    expect(reason(fixture([candidate.firmName, 'We manage residential homes.', 'Paris', '817-555-0101']))).toBe('texas_unproven');
  });
  it('rejects negative or third-party identity and contradictory Texas text', () => {
    expect(reason(fixture([`Not ${candidate.firmName}`, 'Texas residential rentals', '817-555-0101']))).toBe('firm_identity_ambiguous');
    expect(reason(fixture([`Our partner ${candidate.firmName}`, 'Texas residential rentals', '817-555-0101']))).toBe('firm_identity_ambiguous');
    const input = fixture();
    input.observations = [...input.observations, source(['We no longer serve Texas.'], '/area')];
    expect(reason(input)).toBe('texas_conflicts');
  });
  it('does not mutate inputs or the strict email qualification facts', () => {
    const input = fixture(), before = JSON.stringify(input);
    assess(input);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('bounds source counts and malformed timestamps', () => {
    expect(reason({...fixture(), observations: []})).toBe('invalid_evidence');
    expect(reason({...fixture(), now: 'invalid'})).toBe('invalid_evidence');
    const input = fixture();
    input.observations = [...input.observations, ...Array.from({length: 8}, (_, index) => source(['Footer'], `/${index}`))];
    expect(reason(input)).toBe('invalid_evidence');
  });
});
