import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readFirm} from '@fss/domain/crm/firms.ts';
import {decideFirmRead} from '@fss/domain/crm/authorization.ts';
import type {AuthDeps} from '../../../api/src/auth/config.ts';
import {authenticate,type AuthenticatedPrincipal} from '../../../api/src/auth/sessions.ts';
import {contextForPrincipal} from '../../../api/src/routes/routeSupport.ts';

/** A short final read fence, after the potentially waiting policy/registry reads. */
export async function callingReadinessAccess(auth:AuthDeps,token:string,principal:AuthenticatedPrincipal,firmId:string):Promise<boolean>{
 return withTransaction(auth.db,async()=>{
  // Keep assignment/status stable while the normal authentication owner rechecks
  // session, membership, device and clock after all preceding waits.
  await auth.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR SHARE',[principal.workspaceId,firmId]);
  const scoped=contextForPrincipal(auth,principal);
  if(!scoped.ok)return false;
  const firm=await readFirm(scoped.context,firmId);
  const fresh=await authenticate(auth,`Bearer ${token}`);
  if(!fresh.authenticated||fresh.principal.workspaceId!==principal.workspaceId||fresh.principal.userId!==principal.userId||fresh.principal.deviceId!==principal.deviceId||fresh.principal.sessionId!==principal.sessionId||fresh.principal.role!==principal.role)return false;
  return firm!==null&&firm.status==='active'&&decideFirmRead(scoped.context,firm)==='assigned_or_admin';
 });
}
