import type { Queryable, RepositoryContext, WorkspaceScope } from '@fss/domain/db';
import { repositoryContext, workspaceScope } from '@fss/domain/db';

/**
 * Typed workspace scope wiring (specification 5.1, 5.3 and 6).
 *
 * Every mutating command carries a device and a membership, and the scope is built
 * from what the API verified — never from a workspace id in the request body. The
 * three refusals below are the ones that exist before any business logic runs:
 * domain membership alone grants no access, an inactive membership is not access, and
 * a revoked device is not a device.
 *
 * The business commands themselves belong to later slices. What is fixed here is that
 * there is one way to obtain a `RepositoryContext`, it needs a verified principal, and
 * a repository function cannot be written without one.
 */

export interface VerifiedPrincipal {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: 'admin' | 'salesperson';
  readonly membershipStatus: 'active' | 'inactive';
  readonly deviceId: string;
  readonly deviceStatus: 'active' | 'revoked';
}

export type ScopeRefusal = 'membership_inactive' | 'device_revoked' | 'principal_malformed';

export type ScopeOutcome =
  | { readonly authorized: true; readonly scope: WorkspaceScope }
  | { readonly authorized: false; readonly refusal: ScopeRefusal };

/** The scope for a verified principal, or the reason there is not one. Fails closed. */
export function scopeForPrincipal(principal: VerifiedPrincipal): ScopeOutcome {
  if (principal.membershipStatus !== 'active') return { authorized: false, refusal: 'membership_inactive' };
  if (principal.deviceStatus !== 'active') return { authorized: false, refusal: 'device_revoked' };
  try {
    return {
      authorized: true,
      scope: workspaceScope(principal.workspaceId, {
        kind: 'user',
        userId: principal.userId,
        role: principal.role,
      }),
    };
  } catch {
    return { authorized: false, refusal: 'principal_malformed' };
  }
}

/** The scope the worker and the scheduler act under. Never a user, never a role. */
export function systemScope(workspaceId: string, component: 'scheduler' | 'worker'): WorkspaceScope {
  return workspaceScope(workspaceId, { kind: 'system', component });
}

/** The one way to obtain a repository context in the API. */
export function contextFor(scope: WorkspaceScope, db: Queryable): RepositoryContext {
  return repositoryContext(scope, db);
}
