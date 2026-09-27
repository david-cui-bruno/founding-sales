import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The manifest names no file that is not there (1.0.13, P2-1).
 *
 * `exports` pointed at `src/main/index.ts` — a barrel this release deleted. Nothing
 * imported the workspace by name, so nothing failed; it was a promise to resolve a path
 * that no longer existed, waiting for the first importer or the first packaging step to
 * find it. The rule is general rather than a check for that one key: every path the
 * manifest hands to a resolver has to exist.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

/** Every string a resolver would treat as a path: `main`, `bin`, and all of `exports`. */
function pathsIn(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('.') || value.startsWith('/') ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(entry => pathsIn(entry));
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(entry => pathsIn(entry));
  return [];
}

describe("the desktop manifest's entry points", () => {
  it('point at files that exist', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    const named = [manifest['main'], manifest['module'], manifest['types'], manifest['bin'], manifest['exports']].flatMap(
      entry => pathsIn(entry),
    );

    const missing = named.filter(path => !existsSync(resolve(root, path)));
    expect(missing).toEqual([]);
  });

  it('declares no exports: the app is packaged, never imported by name', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    // Electron loads `main.js` out of the asar by path and the wire checks import the
    // source files directly. An `exports` map here would be a second, unused way in.
    expect(manifest['exports']).toBeUndefined();
    expect(manifest['private']).toBe(true);
  });
});
