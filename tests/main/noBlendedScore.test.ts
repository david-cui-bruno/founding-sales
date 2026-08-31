import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';

const ROOT = process.cwd();
const PRIORITIZATION_DIR = join(ROOT, 'src/main/domain/prioritization');
const SCHEMA_FILES = [
  join(ROOT, 'src/main/db/domainSchema.ts'),
  join(ROOT, 'src/main/db/migrations/0002DomainFoundation.ts'),
];
// Task 12 ordering glob; may be empty until Task 12 lands.
const TASK12_DIR = join(ROOT, 'src/main/domain/today');

function productionFiles(): string[] {
  const files = readdirSync(PRIORITIZATION_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(PRIORITIZATION_DIR, name));
  const task12Files = existsSync(TASK12_DIR)
    ? readdirSync(TASK12_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(TASK12_DIR, name))
    : [];
  return [...files, ...SCHEMA_FILES, ...task12Files];
}

/** Strip comments so explanatory prose may name forbidden concepts. */
function productionText(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN_IDENTIFIERS = [
  /lead_score/i,
  /overall_score/i,
  /combined_score/i,
  /blended_score/i,
  /weighted_score/i,
  /fit_weight/i,
  /timing_weight/i,
  /order\s+by\s+score/i,
  /leadScore/,
  /overallScore/,
  /combinedScore/,
  /blendedScore/,
  /weightedScore/,
  /fitWeight/,
  /timingWeight/,
];

describe('no blended score hard ban', () => {
  it('rejects generic ranking aliases in Task 11/12 production files, schema, and migration SQL', () => {
    for (const file of productionFiles()) {
      const text = productionText(file);
      for (const pattern of FORBIDDEN_IDENTIFIERS) {
        expect(pattern.test(text), `${file} matches forbidden pattern ${pattern}`).toBe(false);
      }
      // No public property named exactly `score`.
      expect(/\bscore\s*[:=]/.test(text), `${file} declares a public 'score' property`).toBe(false);
      // No 0-100 priority range.
      expect(/BETWEEN 0 AND 100/i.test(text), `${file} introduces a 0-100 range`).toBe(false);
    }
  });

  it('keeps Fit and Timing separate: no helper arithmetically combines them', () => {
    for (const file of productionFiles()) {
      const text = productionText(file);
      // Any expression multiplying/adding fit and timing values together.
      expect(
        /fit\w*\s*[*+/-]\s*timing/i.test(text) || /timing\w*\s*[*+/-]\s*fit/i.test(text),
        `${file} arithmetically combines Fit and Timing`,
      ).toBe(false);
      expect(
        /order\s+by[^;]*fit_points\s*[*+]\s*/i.test(text),
        `${file} orders by a fit arithmetic combination`,
      ).toBe(false);
    }
  });

  it('exposes exact axes on the qualified result and no generic numeric ranking field', () => {
    const typesText = readFileSync(
      join(PRIORITIZATION_DIR, 'prioritizationTypes.ts'), 'utf8',
    );
    const evaluationBlock = typesText.slice(
      typesText.indexOf('export type QualifiedPrioritizationEvaluation'),
      typesText.indexOf('export type NotPrioritizableEvaluation'),
    );
    for (const field of [
      'fitPoints', 'fitBand', 'timingMilliPoints', 'timingBand', 'priority',
    ]) {
      expect(evaluationBlock).toContain(field);
    }
    expect(evaluationBlock).not.toMatch(/\bscore\b/i);
    expect(evaluationBlock).not.toMatch(/\brank\b/i);
  });

  it('keeps pure engine files free of database, lifecycle, and ambient time/randomness', () => {
    const pureFiles = [
      'qualificationEngine.ts', 'triggerMath.ts', 'priorityMatrix.ts',
      'priorityOrdering.ts', 'builtinPrioritizationRules.ts',
    ].map((name) => join(PRIORITIZATION_DIR, name));
    for (const file of pureFiles) {
      const text = productionText(file);
      for (const forbidden of [
        /from '.*\/db\/database'/,
        /from '.*\/lifecycle\//,
        /from '.*salesCycle/i,
        /from '.*\/events\/eventRepository'/,
        /Date\.now\s*\(/,
        /new Date\s*\(\s*\)/,
        /Math\.random/,
        /randomUUID/,
        /strftime\([^)]*'now'/i,
        /\bnow\(\)/,
      ]) {
        expect(forbidden.test(text), `${file} matches forbidden pattern ${forbidden}`).toBe(false);
      }
    }
  });

  it('keeps post-contact pain and offers out of Prospect Fit/Timing inputs', () => {
    const inputFiles = productionFiles()
      .filter((file) => !SCHEMA_FILES.includes(file));
    for (const file of inputFiles) {
      const text = productionText(file);
      expect(/close[_-]?readiness/i.test(text), `${file} references close readiness`).toBe(false);
      expect(/pain[_-]?point/i.test(text), `${file} references pain points`).toBe(false);
    }
    // Pure engines never see offer facts; the repository may only name the
    // ActivityKind value while parsing immutable rows it filters out.
    const pureFiles = [
      'qualificationEngine.ts', 'triggerMath.ts', 'priorityMatrix.ts', 'priorityOrdering.ts',
    ].map((name) => join(PRIORITIZATION_DIR, name));
    for (const file of pureFiles) {
      const text = productionText(file);
      expect(/\boffer\b/i.test(text), `${file} references offers`).toBe(false);
    }
  });

  it('keeps the rule document free of hidden 0-100 or weighted combination knobs', () => {
    const canonical = JSON.stringify(BUILTIN_PRIORITIZATION_RULE_V1).toLowerCase();
    expect(canonical).not.toContain('weight');
    expect(canonical).not.toContain('score');
    expect(BUILTIN_PRIORITIZATION_RULE_V1.timing.capMilliPoints).toBe(40_000);
    expect(BUILTIN_PRIORITIZATION_RULE_V1.fit.bands.max).toBe(30);
  });
});
