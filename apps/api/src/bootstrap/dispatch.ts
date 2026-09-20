import type { BootstrapRequest, BootstrapResponse, RouteRegistry } from './routeRegistry.ts';

/**
 * Find the module that owns the path and let it answer, or return null.
 *
 * Null rather than a 404 is the point. The caller — `server.ts` here, and
 * `apps/api/src/server.ts` once G2's identity work lands — owns the refusal, so there
 * is exactly one place in the process that decides what an unmounted path looks like
 * from outside. A dispatcher that invented its own 404 would give two different
 * refusals for the same question depending on which router was asked first.
 */
export async function dispatch(
  registry: RouteRegistry,
  request: BootstrapRequest,
): Promise<BootstrapResponse | null> {
  const module = registry.moduleFor(request.path);
  if (module === undefined) return null;
  return module.handle(request);
}
