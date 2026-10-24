import {z} from 'zod';
import {uuid} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readSocialDraftWorkspace,socialDraftView} from '@fss/domain/social/draftWorkspace.ts';
import {readSocialDraftRequest} from '@fss/domain/social/drafts.ts';
import {requirePrincipal,contextForPrincipal} from './routeSupport.ts';
import type {RouteDeps} from './routeSupport.ts';
import type {RouteResult} from './types.ts';
class ChangedPrincipal extends Error{}
/** Read owners may wait on source rows. Reauthenticate the exact principal after
 * those waits, before releasing private results or committing source invalidation. */
export async function readSocialDraftRoute(deps:RouteDeps):Promise<RouteResult>{
 const detail=deps.request.path==='/social/drafts/read';
 const parsed=z.strictObject({requestId:uuid}).safeParse(deps.request.body);
 if(detail?!parsed.success:!z.strictObject({}).safeParse(deps.request.body).success)return {status:400,body:{error:'invalid_input'}};
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const check=async():Promise<void>=>{
  const fresh=await requirePrincipal(deps.auth,deps.request);
  if(!fresh.ok||JSON.stringify(fresh.principal)!==JSON.stringify(deps.principal))throw new ChangedPrincipal();
 };
 try{const answer=await withTransaction(deps.auth.db,async()=>{
  await check();
  const row=detail&&parsed.success?await readSocialDraftRequest(scoped.context,parsed.data.requestId):null;
  const body=detail?(row?{request:socialDraftView(row)}:null):await readSocialDraftWorkspace(scoped.context);
  await check();
  return body===null?{status:404,body:{error:'not_found'}}:{status:200,body};
 });await check();return answer;}catch(error){if(error instanceof ChangedPrincipal)return {status:401,body:{error:'unauthenticated'}};throw error;}
}
