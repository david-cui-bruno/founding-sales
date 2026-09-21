import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JOB_KINDS, JOB_KIND_PROTECTION } from '@fss/domain/jobs';
import { workerDueWorkSources } from '../src/bootstrap/main.ts';

/**
 * The registered due-work sources are the documented ones, in both directions.
 *
 * This is the scenario-22-style completeness check the 21 September deviations sweep
 * asked for. That sweep found three domain functions — `consumeTerminalStops`,
 * `closeSendDay` and the `suppression_finalizations` reader — that a lane had built,
 * tested and exported, and that no later lane had ever called. Every one of them was
 * green in its own package's suite; nothing anywhere compared the list of sources the
 * worker registers with the list the documentation claims, so the gap was invisible to
 * the gate and visible only to somebody reading two files at once.
 *
 * It fails in both directions on purpose. A source added without a row is a behaviour
 * nobody reading `docs/greenfield/processes.md` would know about; a row without a
 * source is the failure this file exists for — work the documentation promises and the
 * scheduler never materializes.
 *
 * `fss admin scheduler run-once` reads the same function, so this also proves Appendix
 * E step 5 rematerialises the whole list rather than whichever subset predates the
 * tool.
 */

const PROCESSES = new URL('../../../docs/greenfield/processes.md', import.meta.url).pathname;

/** The first column of the source table in `docs/greenfield/processes.md`. */
function documentedSources(): readonly string[] {
  const text = readFileSync(PROCESSES, 'utf8');
  const start = text.indexOf('| Source | What it materializes |');
  expect(start, 'processes.md no longer documents the due-work sources').toBeGreaterThan(-1);
  const names: string[] = [];
  for (const line of text.slice(start).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const cell = line.split('|')[1];
    if (cell === undefined) break;
    // One row names four mail sources, because they are one lane's and travel together.
    for (const match of cell.matchAll(/`([a-z][a-z0-9-]*)`/gu)) {
      const name = match[1];
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

describe('the worker registers what the documentation claims', () => {
  it('has a documented row for every registered source, and no row without one', () => {
    const registered = workerDueWorkSources()
      .map(source => source.name)
      .sort();
    expect([...documentedSources()].sort()).toEqual(registered);
  });

  it('registers every source under a distinct name, because the report is keyed by it', () => {
    const names = workerDueWorkSources().map(source => source.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('protects every job kind, so a kind cannot be added without saying how (13.2)', () => {
    // The registry refuses a handler whose declared protection disagrees with
    // `JOB_KIND_PROTECTION`, which only helps if the table has an entry at all.
    for (const kind of JOB_KINDS) expect(JOB_KIND_PROTECTION[kind], kind).toBeDefined();
    expect(Object.keys(JOB_KIND_PROTECTION).sort()).toEqual([...JOB_KINDS].sort());
  });
});
