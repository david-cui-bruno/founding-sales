import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function repositoryPath(relative: string): string {
  return `${REPOSITORY_ROOT}${relative}`;
}

/** A tracked file's text; a missing file fails the check that asked for it. */
export function readRepositoryFile(relative: string): string {
  const path = repositoryPath(relative);
  expect(existsSync(path), `${relative} is referenced by the ops suite and does not exist`).toBe(true);
  return readFileSync(path, 'utf8');
}
