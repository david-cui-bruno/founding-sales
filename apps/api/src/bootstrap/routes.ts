import { ADMIN_JOBS_PATHS, routeAdminJobs } from '../routes/admin/jobs.ts';
import { readinessModule } from './readiness.ts';
import type { BootstrapResponse, RouteModule } from './routeRegistry.ts';

/**
 * What this process mounts.
 *
 * One list, in one file, so "which endpoints does the API serve" has an answer that is
 * read rather than inferred from imports. A later lane adds its module here and to
 * nothing else: the dispatcher, the server and the limits do not change.
 *
 * G2's identity routes are deliberately absent. They are being built in parallel and
 * this lane does not guess their paths; `mountedRoutes` takes extras so the
 * coordinator can add `sessionModule()` without editing this file either.
 */

export function adminJobsModule(): RouteModule {
  return {
    name: 'admin-jobs',
    // G5 exported the list rather than letting a router guess it.
    paths: ADMIN_JOBS_PATHS,
    handle: async (request): Promise<BootstrapResponse | null> => {
      const response = await routeAdminJobs({
        method: request.method,
        path: request.path,
        principal: request.principal,
        body: request.body,
        db: request.db,
      });
      return response === null ? null : { status: response.status, body: response.body };
    },
  };
}

/** Every module this process serves, in mount order. */
export function mountedRoutes(extra: readonly RouteModule[] = []): readonly RouteModule[] {
  return [readinessModule(), adminJobsModule(), ...extra];
}
