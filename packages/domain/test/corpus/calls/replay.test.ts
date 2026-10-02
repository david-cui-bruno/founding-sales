import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoreAnswer, type CorpusCase } from './evaluate.ts';

/**
 * Slice 3a, A-8: the recorded answers of the live evaluation (C2), replayed through today's
 * reader and policy. Nothing is sent. Every recorded run of every counted case must
 * propose no forbidden effect; a reader or policy change that would turn a recorded answer
 * into a forbidden effect fails here before it reaches a call.
 *
 * Answers are kept per prompt version (`answers/<prompt_version>/<case>.run<k>.json`), so an
 * older prompt's answers keep testing the newer reader and policy.
 */

const ROOT = new URL('./', import.meta.url);
const CORPUS = JSON.parse(readFileSync(new URL('cases.json', ROOT), 'utf8')) as { cases: CorpusCase[] };
const ANSWERS = new URL('answers/', ROOT);

interface Recorded {
  readonly promptVersion: string;
  readonly text: string | null;
}

const recorded = readdirSync(ANSWERS)
  .sort()
  .flatMap(version =>
    readdirSync(new URL(`${version}/`, ANSWERS))
      .filter(file => file.endsWith('.json'))
      .sort()
      .map(file => ({ version, file, answer: JSON.parse(readFileSync(new URL(`${version}/${file}`, ANSWERS), 'utf8')) as Recorded })),
  );

describe('A-8: the recorded corpus, replayed', () => {
  it('has recorded answers to replay', () => {
    expect(recorded.length).toBeGreaterThanOrEqual(111);
  });

  it('proposes no forbidden effect in any recorded run of any counted case, and reads every answer', () => {
    const forbidden: string[] = [];
    const unreadable: string[] = [];
    let agreed = 0;
    let compared = 0;
    for (const { version, file, answer } of recorded) {
      const caseId = file.replace(/\.run\d+\.json$/u, '');
      const corpusCase = CORPUS.cases.find(candidate => candidate.id === caseId);
      if (corpusCase === undefined) throw new Error(`${version}/${file} has no case`);
      if (answer.text === null) {
        unreadable.push(`${version}/${file}`);
        continue;
      }
      const score = scoreAnswer(corpusCase, answer.text);
      if (score.read !== 'ok') unreadable.push(`${version}/${file}: ${score.read}`);
      agreed += score.content[0];
      compared += score.content[1];
      for (const verdict of score.verdicts) {
        if (!score.counted || verdict.variant === 'q3_yes') continue;
        if (verdict.forbidden.length > 0) forbidden.push(`${version}/${file} [${verdict.variant}]: ${verdict.forbidden.join(',')}`);
      }
    }
    expect(unreadable).toEqual([]);
    expect(forbidden).toEqual([]);
    // Content agreement is measured on the live run (the 90% rule); recorded here for the record.
    expect(compared).toBeGreaterThan(0);
    console.info(`A-8 content agreement over ${String(recorded.length)} recorded answers: ${String(agreed)}/${String(compared)}`);
  });
});
