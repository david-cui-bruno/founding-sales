import { z } from 'zod';

/**
 * The supported client-version range (specification 5.3).
 *
 * The API publishes it; an outdated client may read only the upgrade instruction and
 * cannot mutate. Fails closed: a version string the parser does not recognise is
 * unsupported, never "probably new enough".
 */

export const semanticVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export type SemanticVersion = z.infer<typeof semanticVersionSchema>;

export const clientVersionRangeSchema = z
  .strictObject({
    /** Below this, the client may read the upgrade instruction and nothing else. */
    minimum: semanticVersionSchema,
    /** The newest version this API knows about. A newer client is told to wait for the API. */
    maximum: semanticVersionSchema,
  })
  .refine(range => compareVersions(range.minimum, range.maximum) <= 0, 'the minimum is not above the maximum');
export type ClientVersionRange = z.infer<typeof clientVersionRangeSchema>;

function parts(version: string): [number, number, number] {
  const [major = '0', minor = '0', patch = '0'] = version.split('.');
  return [Number(major), Number(minor), Number(patch)];
}

/** -1, 0 or 1. Both arguments must already have passed `semanticVersionSchema`. */
export function compareVersions(left: SemanticVersion, right: SemanticVersion): -1 | 0 | 1 {
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const one = a[index] ?? 0;
    const other = b[index] ?? 0;
    if (one < other) return -1;
    if (one > other) return 1;
  }
  return 0;
}

export type ClientCompatibility =
  | { readonly kind: 'supported'; readonly version: SemanticVersion }
  | { readonly kind: 'upgrade_required'; readonly version: SemanticVersion; readonly minimum: SemanticVersion }
  | { readonly kind: 'api_behind_client'; readonly version: SemanticVersion; readonly maximum: SemanticVersion }
  | { readonly kind: 'unreadable_version' };

/** Decide what an announced client version may do. Anything unparseable may do nothing. */
export function clientCompatibility(range: ClientVersionRange, announced: string): ClientCompatibility {
  const parsed = semanticVersionSchema.safeParse(announced);
  if (!parsed.success) return { kind: 'unreadable_version' };
  const version = parsed.data;
  if (compareVersions(version, range.minimum) < 0) {
    return { kind: 'upgrade_required', version, minimum: range.minimum };
  }
  if (compareVersions(version, range.maximum) > 0) {
    return { kind: 'api_behind_client', version, maximum: range.maximum };
  }
  return { kind: 'supported', version };
}

/** Whether a client at this version may issue a mutating command. Reads are separate. */
export function mayMutate(range: ClientVersionRange, announced: string): boolean {
  return clientCompatibility(range, announced).kind === 'supported';
}
