import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { scenario, type Scenario } from './scenarioMap.ts';

/**
 * What a `lane` or `rehearsal` check is allowed to assert, and what it is not.
 *
 * The weakest possible release suite is one that says "a file exists whose name
 * contains the scenario number". These helpers exist so that no check in this
 * directory can be that: `mustCover` requires each referenced file to exist *and* to
 * contain every phrase the scenario is about, so a lane test that was renamed, gutted
 * or reduced to a placeholder fails here even though its own suite still passes.
 *
 * That is deliberately a weaker guarantee than running the assertion, and it is why
 * `lane` scenarios also run for real: `npm run gate:greenfield` runs
 * `test:greenfield` and `test:release` in the same chain, so the lane suites execute
 * beside these checks rather than instead of them. This directory's job is to make the
 * *map* from Appendix G to the proof complete and falsifiable — a scenario with no
 * proof, or a proof that stopped proving it, is a red build.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function repositoryPath(relative: string): string {
  return `${REPOSITORY_ROOT}${relative}`;
}

export function readRepositoryFile(relative: string): string {
  const path = repositoryPath(relative);
  expect(existsSync(path), `${relative} is referenced by the release suite and does not exist`).toBe(true);
  return readFileSync(path, 'utf8');
}

/** Every referenced file exists. The floor, never the whole assertion. */
export function referencesExist(entry: Scenario): void {
  for (const reference of entry.references) {
    expect(existsSync(repositoryPath(reference)), `${reference} is missing`).toBe(true);
  }
}

/**
 * The scenario's proof still says what it is supposed to say.
 *
 * `phrases` are substrings that must appear somewhere across the referenced files —
 * the names of the functions, columns, constants or refusal codes the scenario is
 * about. They are chosen to be things that disappear when the behaviour is removed,
 * not prose that survives a rewrite.
 */
export function mustCover(number: number, phrases: readonly string[]): Scenario {
  const entry = scenario(number);
  referencesExist(entry);
  const corpus = entry.references.map(reference => readRepositoryFile(reference)).join('\n');
  for (const phrase of phrases) {
    expect(corpus.includes(phrase), `Appendix G ${String(number)}: no referenced file mentions ${phrase}`).toBe(
      true,
    );
  }
  // A scenario whose trap is unnamed is a scenario nobody checked for vacuity.
  expect(entry.trap.length, `Appendix G ${String(number)} names no vacuous-pass trap`).toBeGreaterThan(30);
  expect(entry.closedBy.length, `Appendix G ${String(number)} does not say how the trap is closed`).toBeGreaterThan(
    30,
  );
  return entry;
}

/** A rehearsal-only scenario names a script, and the release workflow runs it. */
export function mustBeRehearsed(number: number): Scenario {
  const entry = scenario(number);
  referencesExist(entry);
  const script = entry.script;
  expect(script, `Appendix G ${String(number)} is rehearsal-only and names no script`).toBeDefined();
  expect(existsSync(repositoryPath(script as string)), `${String(script)} is missing`).toBe(true);
  const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
  expect(
    workflow.includes(script as string),
    `the release workflow never runs ${String(script)}, so Appendix G ${String(number)} would never be rehearsed`,
  ).toBe(true);
  return entry;
}
