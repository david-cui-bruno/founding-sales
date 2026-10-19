import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import type {SourceObservation} from '@fss/contracts';
import {currentOfficeSources, reconstructOfficeSelections, validOfficeProof} from '../../research/officeAssessmentEvidence.ts';
import {officeHash} from '../../research/officeAssessmentTarget.ts';
import {parseOfficeExtractionAnswer} from '../../research/officeEvidencePrompt.ts';

const now = '2026-10-19T20:00:00.000Z';
const candidate = {firmName: 'Northwind Test Holdings', website: 'https://northwind.example.test', locality: 'Providence', region: 'RI' as const};
function source(text = 'Northwind Test Holdings manages residential properties in Providence, RI.'): SourceObservation {
  const blocks = [{id: 'b1', text}];
  return {
    id: randomUUID(), url: candidate.website, contentHash: 'a'.repeat(64),
    relevantTextHash: officeHash(JSON.stringify(blocks)), retrievedAt: now,
    publishedAt: null, publishedAtBlockId: null, firstParty: true, truncated: false, blocks,
  };
}

describe('strict office retained proof bounds', () => {
  it('rejects overbound observations without choosing a smaller evidence subset', () => {
    expect(validOfficeProof([source()], [])).toBe(true);
    expect(validOfficeProof(Array.from({length: 9}, () => source()), [])).toBe(false);
    expect(validOfficeProof([source('x'.repeat(4001))], [])).toBe(false);
    const many = source();
    many.blocks = Array.from({length: 101}, (_, index) => ({id: `b${index}`, text: 'Published block'}));
    many.relevantTextHash = officeHash(JSON.stringify(many.blocks));
    expect(validOfficeProof([many], [])).toBe(false);
    const large = source();
    large.blocks = Array.from({length: 30}, (_, index) => ({id: `b${index}`, text: 'x'.repeat(3500)}));
    large.relevantTextHash = officeHash(JSON.stringify(large.blocks));
    expect(validOfficeProof([large], [])).toBe(false);
  });

  it.each([
    {firstParty: false}, {truncated: true}, {url: 'https://foreign.example.test'},
    {retrievedAt: '2026-10-19T20:00:01.000Z'}, {retrievedAt: '2026-10-12T20:00:00.000Z'},
    {relevantTextHash: 'f'.repeat(64)},
  ])('rejects unavailable or noncurrent proof %#', patch => {
    expect(currentOfficeSources(candidate, [{...source(), ...patch}], now)).toBe(false);
  });

  it('refuses unoffered IDs, invented literals, and overlong selected blocks', () => {
    const observation = source();
    const selection = {kind: 'firm_identity' as const, observationId: observation.id, blockId: 'b1'};
    expect(reconstructOfficeSelections(candidate, [observation], [{...selection, observationId: randomUUID()}])).toBeNull();
    expect(reconstructOfficeSelections(candidate, [observation], [{...selection, blockId: 'unoffered'}])).toBeNull();
    expect(validOfficeProof([observation], [{...selection, value: 'Invented paraphrase'}])).toBe(false);
    const long = source('x'.repeat(2001));
    expect(reconstructOfficeSelections(candidate, [long], [{...selection, observationId: long.id}])).toBeNull();
  });

  it('refuses more than thirty selectors locally without asking for another call', () => {
    const observation = source();
    const selections = Array.from({length: 31}, () => ({kind: 'firm_identity', observationId: observation.id, blockId: 'b1'}));
    expect(parseOfficeExtractionAnswer(JSON.stringify({selections}))).toBeNull();
    expect(parseOfficeExtractionAnswer('{"selections":[')).toBeNull();
  });
});
