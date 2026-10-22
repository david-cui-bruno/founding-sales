import type { RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { readFirm } from '@fss/domain/crm/firms.ts';
import { decideFirmRead } from '@fss/domain/crm/authorization.ts';
import type { AuthenticatedPrincipal } from '../auth/sessions.ts';
import { requirePrincipal, type RouteDeps } from './routeSupport.ts';
import type { RouteResult } from './types.ts';

/** Pin the actor, not just the bearer token: membership roles can change in flight. */
export function samePrivatePrincipal(before: AuthenticatedPrincipal, after: AuthenticatedPrincipal): boolean {
  return before.workspaceId === after.workspaceId && before.userId === after.userId &&
    before.sessionId === after.sessionId && before.deviceId === after.deviceId && before.role === after.role;
}

export async function privatePrincipalIsCurrent(deps: RouteDeps): Promise<boolean> {
  const current = await requirePrincipal(deps.auth, deps.request);
  return current.ok && samePrivatePrincipal(deps.principal, current.principal);
}

export const privateAuthorityRefusal = (): RouteResult => ({ status: 401, body: { error: 'session_changed' } });

/** Re-read the actual Firm after assembly, never an assignment cached in the DTO. */
export async function privateFirmIsCurrent(context: RepositoryContext, firmId: string): Promise<boolean> {
  const firm = await readFirm(context, firmId);
  return firm !== null && firm.status === 'active' && decideFirmRead(context, firm) === 'assigned_or_admin';
}

/** A second domain read validates source removal/revision without a parallel access engine. */
export async function unchangedPrivateProjection<T>(before: T, read: () => Promise<T>, normalize: (value: T) => unknown = value => value): Promise<boolean> {
  return JSON.stringify(normalize(before)) === JSON.stringify(normalize(await read()));
}
