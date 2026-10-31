import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {phoneDiscoverySourceLimit} from './prospectPhoneDiscoveryAuthority.ts';

/** Reuse the existing per-URL denial/retention owner; this is no phone grant.
 * The caller separately checks current run, research settings, holds and budget.
 * The adapter still owns URL/DNS/robots checks before every actual request. */
export async function preparedCaptureSourcesAvailable(ctx:RepositoryContext,urls:readonly string[]):Promise<boolean> {
 if(ctx.scope.actor.kind==='user'&&!await activeIdentityActor(ctx))return false;
 return !(await phoneDiscoverySourceLimit(ctx,urls)).denied;
}
