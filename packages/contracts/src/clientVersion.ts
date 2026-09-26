import { z } from 'zod';

/**
 * The supported client-version range (specification 5.3), and since lane g78 the
 * compatibility ceiling the API derives it from.
 *
 * The API publishes a range; an outdated client may read only the upgrade instruction
 * and cannot mutate. Fails closed: a version string the parser does not recognise is
 * unsupported, never "probably new enough".
 */

export const semanticVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export type SemanticVersion = z.infer<typeof semanticVersionSchema>;

/**
 * The range as it travels: `/auth/client-version`'s `supported`, every sign-in and
 * renewal grant's `supportedClientVersions`, and `/diagnostics`' `clientVersions`.
 *
 * A strict object, and it has to stay one with exactly these two keys: desktops 1.0.0
 * to 1.0.4 parse all three answers with this schema, so a third key would make every
 * installed Mac refuse its own sign-in. The ceiling below is published *through* this
 * shape rather than beside it. `docs/decisions/g78-version-ceiling.md`.
 */
export const clientVersionRangeSchema = z
  .strictObject({
    /** Below this, the client may read the upgrade instruction and nothing else. */
    minimum: semanticVersionSchema,
    /** The newest version this API admits. A newer client is told to wait for the API. */
    maximum: semanticVersionSchema,
  })
  .refine(range => compareVersions(range.minimum, range.maximum) <= 0, 'the minimum is not above the maximum');
export type ClientVersionRange = z.infer<typeof clientVersionRangeSchema>;

// ---------------------------------------------------------------------------
// The compatibility ceiling (lane g78, audit item O04)
// ---------------------------------------------------------------------------

/**
 * The highest release line an API promises to serve: `1.x` is every 1.* build,
 * `1.4.x` every 1.4.* build.
 *
 * Until lane g78 the API published the exact latest desktop version as its maximum,
 * so every desktop-only release needed an API deployment first. A line is a promise
 * about the protocol instead: the API keeps every route and every response field an
 * admitted build reads (`docs/decisions/g78-one-wire-contract.md` says what that
 * promise covers), so a new patch or minor on the line is admitted without the API
 * knowing its number. A build that turns out to be bad is named in `incompatible`.
 */
const clientVersionCeilingSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.((0|[1-9]\d*)\.)?x$/u, 'a release line such as 1.x or 1.4.x');
type ClientVersionCeiling = z.infer<typeof clientVersionCeilingSchema>;

/**
 * The largest minor and patch number a line admits.
 *
 * The published maximum of `1.x` is `1.999.999`, and the admission check compares
 * against that same version, so the API and a 1.0.x Mac reading the published range
 * can never disagree about a version: the ceiling is one number, spelled two ways.
 */
const CEILING_COMPONENT_LIMIT = 999;

/** `1.x` → `1.999.999`; `1.4.x` → `1.4.999`. */
export function ceilingMaximum(ceiling: ClientVersionCeiling): SemanticVersion {
  const [major = '0', minor = 'x'] = ceiling.split('.');
  const limit = String(CEILING_COMPONENT_LIMIT);
  return minor === 'x' ? `${major}.${limit}.${limit}` : `${major}.${minor}.${limit}`;
}

/**
 * What the API admits: every version from `minimum` to the top of `ceiling`, except
 * the builds named in `incompatible`.
 */
export const clientVersionPolicySchema = z
  .strictObject({
    /** Below this, the client may read the upgrade instruction and nothing else. */
    minimum: semanticVersionSchema,
    ceiling: clientVersionCeilingSchema,
    /**
     * Known-bad builds inside the range. Refused like an outdated client — every
     * sign-in, renewal and command answers `client_upgrade_required` — and fixed the
     * same way, by the next build on the update channel.
     */
    incompatible: z.array(semanticVersionSchema).max(100),
  })
  .refine(policy => compareVersions(policy.minimum, ceilingMaximum(policy.ceiling)) <= 0, {
    message: 'the minimum is not above the ceiling',
  })
  .refine(
    policy =>
      policy.incompatible.every(
        version =>
          compareVersions(version, policy.minimum) >= 0 && compareVersions(version, ceilingMaximum(policy.ceiling)) <= 0,
      ),
    // A listed version outside the range would already be refused, and a list that
    // looks as though it is doing something it is not is how a bad build gets missed.
    { message: 'every incompatible version lies inside the admitted range' },
  )
  .refine(policy => new Set(policy.incompatible).size === policy.incompatible.length, {
    message: 'an incompatible version is listed once',
  });
export type ClientVersionPolicy = z.infer<typeof clientVersionPolicySchema>;

/**
 * The range the API publishes for a policy: `{ minimum, maximum: ceilingMaximum }`.
 *
 * This is the whole backward-compatibility story for desktops 1.0.0 to 1.0.4. They
 * read `{ minimum, maximum }` with the strict schema above and compare their own
 * version against it; `1.0.0`–`1.999.999` parses, and admits them. The incompatible
 * list is not published: an installed Mac could not parse a new key, and it does not
 * need to — the API refuses a listed build itself.
 */
export function publishedClientVersions(policy: ClientVersionPolicy): ClientVersionRange {
  return { minimum: policy.minimum, maximum: ceilingMaximum(policy.ceiling) };
}

/** `1.999.999` reads as `any 1.x`, so a person is not shown a version that will never exist. */
export function describeClientVersionMaximum(maximum: SemanticVersion): string {
  const [major = '0', minor = '0', patch = '0'] = maximum.split('.');
  const limit = String(CEILING_COMPONENT_LIMIT);
  if (minor === limit && patch === limit) return `any ${major}.x`;
  if (patch === limit) return `any ${major}.${minor}.x`;
  return maximum;
}

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

type ClientCompatibility =
  | { readonly kind: 'supported'; readonly version: SemanticVersion }
  | { readonly kind: 'upgrade_required'; readonly version: SemanticVersion; readonly minimum: SemanticVersion }
  | { readonly kind: 'api_behind_client'; readonly version: SemanticVersion; readonly maximum: SemanticVersion }
  /** A build inside the range that the API's policy names as known-bad. */
  | { readonly kind: 'incompatible'; readonly version: SemanticVersion }
  | { readonly kind: 'unreadable_version' };

/**
 * Either half of the gate: the API holds a policy, a Mac holds the range it was
 * published. They decide identically for every version the policy does not list.
 */
type ClientVersionGate = ClientVersionRange | ClientVersionPolicy;

function rangeOf(gate: ClientVersionGate): ClientVersionRange {
  return 'ceiling' in gate ? publishedClientVersions(gate) : gate;
}

/** Decide what an announced client version may do. Anything unparseable may do nothing. */
export function clientCompatibility(gate: ClientVersionGate, announced: string): ClientCompatibility {
  const parsed = semanticVersionSchema.safeParse(announced);
  if (!parsed.success) return { kind: 'unreadable_version' };
  const version = parsed.data;
  const range = rangeOf(gate);
  if (compareVersions(version, range.minimum) < 0) {
    return { kind: 'upgrade_required', version, minimum: range.minimum };
  }
  if (compareVersions(version, range.maximum) > 0) {
    return { kind: 'api_behind_client', version, maximum: range.maximum };
  }
  if ('incompatible' in gate && gate.incompatible.includes(version)) {
    return { kind: 'incompatible', version };
  }
  return { kind: 'supported', version };
}

/** Whether a client at this version may issue a mutating command. Reads are separate. */
export function mayMutate(gate: ClientVersionGate, announced: string): boolean {
  return clientCompatibility(gate, announced).kind === 'supported';
}
