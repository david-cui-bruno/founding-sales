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
  readonly db: Queryable;
  readonly readiness: ReadinessInputs;
}

export interface BootstrapResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface RouteModule {
  /** For the mounted-route log line an operator reads at startup. */
  readonly name: string;
  /** Exact paths. No prefixes and no patterns: a route is mounted or it is not. */
  readonly paths: readonly string[];
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
  /** Every mounted path, sorted and unique. */
  paths(): readonly string[];
  moduleFor(path: string): RouteModule | undefined;
  modules(): readonly RouteModule[];
}

export function createRouteRegistry(modules: readonly RouteModule[]): RouteRegistry {
  const byPath = new Map<string, RouteModule>();
  for (const module of modules) {
    for (const path of module.paths) {
      if (!path.startsWith('/') || path.includes('?') || path.includes('..')) {
        throw new RouteRegistryError('PATH_MALFORMED', `${module.name} claims a path that is not an absolute route`);
      }
      const existing = byPath.get(path);
      if (existing !== undefined) {
        throw new RouteRegistryError(
          'PATH_CLAIMED_TWICE',
          `${path} is claimed by both ${existing.name} and ${module.name}`,
        );
      }
      byPath.set(path, module);
    }
  }
  const sorted = [...byPath.keys()].sort();
  return {
    paths: () => sorted,
    moduleFor: path => byPath.get(path),
    modules: () => modules,
  };
}
