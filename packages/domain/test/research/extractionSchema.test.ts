import { describe, expect, it } from 'vitest';
import { EXTRACTION_OUTPUT_SCHEMA, EXTRACTION_PROMPT_VERSION } from '../../research/extractionPrompt.ts';
import { schemaProblems } from '../support/structuredOutputsSchema.ts';

/**
 * Research's provider schema keeps the structured-outputs rules the reply classifier and the
 * summary keep (the shared walker). The first schema carried `minItems`, `maxItems` and
 * `maxLength`, and Amazon Bedrock refused it with "For 'array' type, property 'maxItems' is
 * not supported" (1 October 2026). The request the adapter builds for every research model is
 * walked in `apps/worker/test/researchExtraction.test.ts`.
 */
describe('the research provider schema', () => {
  it('passes the shared walker', () => {
    expect(schemaProblems(EXTRACTION_OUTPUT_SCHEMA)).toEqual([]);
  });

  it('is the second version: the limits moved into the reader', () => {
    expect(EXTRACTION_PROMPT_VERSION).toBe('research.extract.2');
  });
});
