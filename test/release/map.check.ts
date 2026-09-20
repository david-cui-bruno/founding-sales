import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REHEARSAL_ONLY, SCENARIOS } from './support/scenarioMap.ts';
import { referencesExist, repositoryPath } from './support/coverage.ts';

/**
 * The map from Appendix G to its proof is complete, and stays complete.
 *
 * 16.2: "Any release touching database schema, sending, suppression, Gmail, restore or
 * job fencing runs the full recovery drill". Appendix G is the list of what that drill
 * and its suite must cover, and a list is only useful if nothing can quietly fall off
 * it. So this file asserts the shape rather than any one scenario: forty-two numbers,
 * one file each, every referenced path present, every rehearsal-only entry carrying a
 * script, and no entry without a named vacuous-pass trap.
 *
 * ## The vacuous-pass trap, named
 *
 * The obvious failure here is a map that asserts things about itself. If the map said
 * "42 entries" and somebody deleted one and changed the number, everything would still
 * pass. That is closed two ways: the count is compared with Appendix G's literal range
 * 1..42 rather than with the array's own length, and the set of `scenarioNN.check.ts`
 * files on disk is compared with the map, so a check file deleted without its entry —
 * or an entry added without its file — fails.
 */

describe('the Appendix G map', () => {
  it('has exactly the numbers 1 to 42, once each', () => {
    const numbers = SCENARIOS.map(entry => entry.number).sort((left, right) => left - right);
    expect(numbers).toEqual(Array.from({ length: 42 }, (_, index) => index + 1));
  });

  it('has one check file per scenario and no orphans', () => {
    const files = readdirSync(repositoryPath('test/release'))
      .filter(name => /^scenario\d\d\.check\.ts$/u.test(name))
      .sort();
    const expected = SCENARIOS.map(entry => `scenario${String(entry.number).padStart(2, '0')}.check.ts`).sort();
    expect(files).toEqual(expected);
  });

  it('names every referenced file, and every one of them exists', () => {
    for (const entry of SCENARIOS) {
      expect(entry.references.length, `Appendix G ${String(entry.number)} references nothing`).toBeGreaterThan(0);
      referencesExist(entry);
    }
  });

  it('marks exactly 11, 20, 22, 39 and 42 rehearsal-only, each with a script', () => {
    const rehearsal = SCENARIOS.filter(entry => entry.coverage === 'rehearsal').map(entry => entry.number);
    expect(rehearsal.sort((left, right) => left - right)).toEqual([...REHEARSAL_ONLY]);
    for (const entry of SCENARIOS) {
      if (entry.coverage === 'rehearsal') expect(entry.script, `${String(entry.number)} has no script`).toBeDefined();
      else expect(entry.script, `${String(entry.number)} is not rehearsal-only but names a script`).toBeUndefined();
    }
  });

  it('names a vacuous-pass trap and its closure for every scenario', () => {
    for (const entry of SCENARIOS) {
      expect(entry.trap.length, `Appendix G ${String(entry.number)} names no trap`).toBeGreaterThan(30);
      expect(entry.closedBy.length, `Appendix G ${String(entry.number)} does not close its trap`).toBeGreaterThan(30);
      expect(entry.trap, `Appendix G ${String(entry.number)}'s trap repeats its closure`).not.toEqual(entry.closedBy);
    }
  });

  it('gives every scenario a title rather than only a number', () => {
    for (const entry of SCENARIOS) {
      expect(entry.title.length, `Appendix G ${String(entry.number)} has no title`).toBeGreaterThan(20);
    }
  });
});
