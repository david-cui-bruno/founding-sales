import type { Queryable, SessionQueryable } from '@fss/domain/db';
import type { VerifiedPrincipal } from '../scope.ts';

/**
 * The route registry.
 *
 * G0 decided the API is `node:http` with one handler and no framework
 * (`docs/decisions/g0-api-http-server.md`), and that a path nothing mounted is refused
 * rather than falling through. The consequence is that every new slice would otherwise
 * edit the same router function, and two lanes working at once would collide on it.
 *
 * A module declares the paths it owns and gets them, or the registry refuses to be
 * built. That is deliberate: two modules claiming `/admin/jobs/requeue` is not a
 * merge conflict to be discovered at runtime by whichever import happened to be
 * first — one of them would silently never run, and it might be the one with the
 * authorization in it.
 *
 * The request a module sees is already verified. It carries a principal or null, never
 * a raw session cookie, and never a workspace id taken from a body.
 */

export interface ReadinessInputs {
  /** One connection; readiness asks the database two questions and holds no transaction. */
  readonly session: SessionQueryable;
  /** Appendix E step 1: the generation the operator pinned, or null when none is. */
  readonly expectedSystemGeneration: number | null;
}

export interface BootstrapRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Null for an unauthenticated request. Produced by G2's verification, never here. */
  readonly principal: VerifiedPrincipal | null;
  readonly body?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The parsed query string, for the two endpoints that have one: Google's OAuth
   * redirect arrives as `GET /auth/google/callback?state=…&code=…` and there is no
   * body to put it in. Optional, because nothing else reads it and a module that
   * does not ask cannot accidentally take a workspace id from a URL.
   */
  readonly query?: URLSearchParams | undefined;
  readonly db: Queryable;
  readonly readiness: ReadinessInputs;
}

export interface BootstrapResponse {
  readonly status: number;
  readonly body: unknown;
  /** Defaults to `application/json; charset=utf-8`. The OAuth callback serves HTML. */
  readonly contentType?: string | undefined;
}

export interface RouteModule {
  /** For the mounted-route log line an operator reads at startup. */
  readonly name: string;
  /** Exact paths. No patterns: a route is mounted or it is not. */
  readonly paths: readonly string[];
  /**
   * Whole path segments this module owns, including everything beneath them.
   *
   * Exact paths remain the rule and every new endpoint should be one. A prefix
   * exists for the two shapes that cannot be enumerated: a record read whose last
   * segment is an identifier (`GET /firms/<uuid>`), and a module that already
   * answers `not_found` for the unknown paths under its own root rather than
   * letting them fall through to another module. The collision rules below are the
   * same rules as for an exact path — two claims on one path is still a refusal —
   * so a prefix cannot silently swallow another module's route.
   */
  readonly prefixes?: readonly string[] | undefined;
  handle(request: BootstrapRequest): Promise<BootstrapResponse | null>;
}

export class RouteRegistryError extends Error {
  constructor(
    readonly code: 'PATH_CLAIMED_TWICE' | 'PATH_MALFORMED',
    message: string,
  ) {
    super(message);
    this.name = 'RouteRegistryError';
  }
}

export interface RouteRegistry {
  /** Every mounted exact path, sorted and unique. */
  paths(): readonly string[];
  /** Every mounted prefix, sorted and unique. */
  prefixes(): readonly string[];
  moduleFor(path: string): RouteModule | undefined;
  modules(): readonly RouteModule[];
}

function assertWellFormed(module: RouteModule, path: string): void {
  if (!path.startsWith('/') || path.includes('?') || path.includes('..') || path.endsWith('/')) {
    throw new RouteRegistryError('PATH_MALFORMED', `${module.name} claims a path that is not an absolute route`);
  }
}

/** Whether `path` is the prefix itself or a whole segment beneath it. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function createRouteRegistry(modules: readonly RouteModule[]): RouteRegistry {
  const byPath = new Map<string, RouteModule>();
  const byPrefix = new Map<string, RouteModule>();

  for (const module of modules) {
    for (const path of module.paths) {
      assertWellFormed(module, path);
      const existing = byPath.get(path);
      if (existing !== undefined) {
        throw new RouteRegistryError(
          'PATH_CLAIMED_TWICE',
          `${path} is claimed by both ${existing.name} and ${module.name}`,
        );
      }
      byPath.set(path, module);
    }
    for (const prefix of module.prefixes ?? []) {
      assertWellFormed(module, prefix);
      const existing = byPrefix.get(prefix);
      if (existing !== undefined) {
        throw new RouteRegistryError(
          'PATH_CLAIMED_TWICE',
          `${prefix} is claimed by both ${existing.name} and ${module.name}`,
        );
      }
      byPrefix.set(prefix, module);
    }
  }

  // A prefix that contains, or is contained by, another module's claim is the same
  // fault as two modules claiming one path: one of them silently never runs.
  for (const [prefix, owner] of byPrefix) {
    for (const [otherPrefix, otherOwner] of byPrefix) {
      if (otherOwner === owner || !underPrefix(otherPrefix, prefix)) continue;
      throw new RouteRegistryError(
        'PATH_CLAIMED_TWICE',
        `${otherPrefix} is beneath ${prefix}; ${owner.name} and ${otherOwner.name} both claim it`,
      );
    }
    for (const [path, pathOwner] of byPath) {
      if (pathOwner === owner || !underPrefix(path, prefix)) continue;
      throw new RouteRegistryError(
        'PATH_CLAIMED_TWICE',
        `${path} is beneath ${prefix}; ${owner.name} and ${pathOwner.name} both claim it`,
      );
    }
  }

  const sorted = [...byPath.keys()].sort();
  const sortedPrefixes = [...byPrefix.keys()].sort();
  return {
    paths: () => sorted,
    prefixes: () => sortedPrefixes,
    // Exact first. Prefixes cannot overlap, so there is at most one match and no
    // "longest wins" rule a reader would have to hold in their head.
    moduleFor: path => byPath.get(path) ?? [...byPrefix].find(([prefix]) => underPrefix(path, prefix))?.[1],
    modules: () => modules,
  };
}
