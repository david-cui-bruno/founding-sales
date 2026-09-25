import type { z } from 'zod';

/**
 * How a response schema in this package is held to the route that sends it
 * (lane g78, audit items D07 and B01).
 *
 * Every response DTO here is a `z.object`, which *strips* a key it does not declare
 * rather than refusing the whole answer. That is the Mac's half, and it is deliberate:
 * with the compatibility ceiling (`docs/decisions/g78-version-ceiling.md`) an API is
 * deployed ahead of the desktops it serves, and a strict parser on an installed Mac
 * would turn every field the API adds into an answer that Mac can no longer read.
 *
 * The strictness lives where the drift is born instead. A route's own test runs its
 * real answer through `wireDrift`, which is the schema's parse plus the one thing a
 * stripping parse cannot say by itself: which keys it dropped. An undeclared key, a
 * missing one, a wrong type or a value outside a closed vocabulary is a line in the
 * answer, so the test that reads it fails the day the route and the contract part —
 * in the API's CI, not on David's Mac.
 */

/** Every way `value` differs from what `schema` declares, as `path: problem`. Empty means exact. */
export function wireDrift(schema: z.ZodType, value: unknown): readonly string[] {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.map(issue => `${pathOf(issue.path)}: ${issue.message}`);
  }
  const lost: string[] = [];
  collectStripped(value, parsed.data, [], lost);
  return lost;
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(root)' : path.map(String).join('.');
}

function collectStripped(sent: unknown, kept: unknown, path: readonly PropertyKey[], lost: string[]): void {
  if (Array.isArray(sent) && Array.isArray(kept)) {
    sent.forEach((entry, index) => {
      collectStripped(entry, kept[index], [...path, index], lost);
    });
    return;
  }
  if (!isRecord(sent) || !isRecord(kept)) return;
  for (const key of Object.keys(sent)) {
    if (!(key in kept)) {
      lost.push(`${pathOf([...path, key])}: not declared by the contract`);
      continue;
    }
    collectStripped(sent[key], kept[key], [...path, key], lost);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
