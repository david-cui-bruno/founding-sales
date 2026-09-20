import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every directory an image's entry point reaches is in that image's allow-list.
 *
 * `Dockerfile.api.dockerignore` and `Dockerfile.worker.dockerignore` exclude
 * everything and allow four-or-so directories back in, which is the right shape:
 * "a deny list would silently ship whatever the next lane adds". But an allow-list
 * has the opposite failure, and it has already happened twice — G3b's PR 135 shipped
 * an API that imported `@fss/domain/crm` without `packages/domain/crm` in the image,
 * and the container failed at load with `ERR_MODULE_NOT_FOUND`.
 *
 * The subtle half is that the list cannot be derived from what `apps/<process>/src`
 * imports. `apps/worker/src` names only `@fss/domain/suppression`, but that module
 * imports from `../crm` and `../policy`, so the worker image needs all three. The
 * closure below is transitive for exactly that reason.
 *
 * Docker is not available on this machine and CI builds the images; this test is the
 * part of that check which can run on a laptop, and it fails in the same second
 * rather than twenty minutes into a pipeline.
 */

const REPOSITORY_ROOT = new URL('../../../../', import.meta.url).pathname;
const DOMAIN_ROOT = join(REPOSITORY_ROOT, 'packages/domain');

/** Subdirectories of `packages/domain` that are importable units, not build output. */
function domainDirectories(): readonly string[] {
  return readdirSync(DOMAIN_ROOT)
    .filter(name => !name.startsWith('.') && name !== 'node_modules' && name !== 'test' && name !== 'scripts')
    .filter(name => statSync(join(DOMAIN_ROOT, name)).isDirectory());
}

function typescriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...typescriptFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

const KNOWN = new Set(domainDirectories());

/** The `@fss/domain/<dir>` subpaths an application's own source names. */
function directlyImported(applicationSource: string): Set<string> {
  const wanted = new Set<string>();
  for (const file of typescriptFiles(applicationSource)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/@fss\/domain\/([a-z]+)/gu)) {
      const directory = match[1];
      if (directory !== undefined && KNOWN.has(directory)) wanted.add(directory);
    }
    // A bare `@fss/domain` is `packages/domain/src`, through the package's exports map.
    if (/from '@fss\/domain'/u.test(text)) wanted.add('src');
  }
  return wanted;
}

/** Everything those directories reach through relative imports, transitively. */
function closure(seeds: Iterable<string>): Set<string> {
  const reached = new Set(seeds);
  const pending = [...reached];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const file of typescriptFiles(join(DOMAIN_ROOT, directory))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '\.\.\/([a-z]+)\//gu)) {
        const next = match[1];
        if (next === undefined || !KNOWN.has(next) || reached.has(next)) continue;
        reached.add(next);
        pending.push(next);
      }
    }
  }
  return reached;
}

interface ImageUnderTest {
  readonly name: string;
  readonly dockerfile: string;
  readonly dockerignore: string;
  readonly applicationSource: string;
}

const IMAGES: readonly ImageUnderTest[] = [
  {
    name: 'api',
    dockerfile: 'Dockerfile.api',
    dockerignore: 'Dockerfile.api.dockerignore',
    applicationSource: join(REPOSITORY_ROOT, 'apps/api/src'),
  },
  {
    name: 'worker',
    dockerfile: 'Dockerfile.worker',
    dockerignore: 'Dockerfile.worker.dockerignore',
    applicationSource: join(REPOSITORY_ROOT, 'apps/worker/src'),
  },
];

describe.each(IMAGES.map(image => [image.name, image] as const))(
  'the %s image ships every domain directory it reaches',
  (_name, image) => {
    const needed = [...closure(directlyImported(image.applicationSource))].sort();

    it('copies each of them', () => {
      const dockerfile = readFileSync(join(REPOSITORY_ROOT, image.dockerfile), 'utf8');
      const copied = needed.filter(directory =>
        dockerfile.includes(`COPY packages/domain/${directory} packages/domain/${directory}`),
      );
      // `db/testing` is deleted again by a RUN in both images; that is the harness,
      // and it is a removal rather than an omission.
      expect(copied, `${image.dockerfile} is missing a COPY for one of ${needed.join(', ')}`).toEqual(needed);
    });

    it('allows each of them back into the build context', () => {
      const ignore = readFileSync(join(REPOSITORY_ROOT, image.dockerignore), 'utf8');
      const allowed = needed.filter(directory => ignore.includes(`!packages/domain/${directory}`));
      expect(allowed, `${image.dockerignore} is missing a !packages/domain/<dir> for one of ${needed.join(', ')}`).toEqual(
        needed,
      );
    });

    it('reaches at least the directories its own source names', () => {
      // A sanity check on the closure itself: it can only grow.
      for (const direct of directlyImported(image.applicationSource)) expect(needed).toContain(direct);
    });
  },
);
