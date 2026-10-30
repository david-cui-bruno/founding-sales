import {preparedProspectListInputSchema,preparedProspectReadInputSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {listPreparedProspects,readPreparedProspect} from '@fss/domain/sourcing/preparedProspects.ts';
import {contextForPrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalPublicationAuthority} from './retainedPrincipalAuthority.ts';
import type {RouteResult} from './types.ts';

export const PREPARED_PROSPECT_PATHS=['/sourcing/prepared-prospects/list','/sourcing/prepared-prospects/read'] as const;
/** Private retained-source projection. No command, receipt or channel mutation. */
export async function routePreparedProspects(deps:RouteDeps):Promise<RouteResult>{
 if(deps.principal.role!=='admin')return {status:403,body:{error:'admin_only'}};
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const list=deps.request.path===PREPARED_PROSPECT_PATHS[0];
 const parsed=list?preparedProspectListInputSchema.safeParse(deps.request.body):preparedProspectReadInputSchema.safeParse(deps.request.body);
 if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
 const publication=retainedPrincipalPublicationAuthority(deps,scoped.context);
 const answer=await withTransaction(deps.auth.db,async()=>{
  const ctx=scoped.context,authority=publication.authority;
  const result=list?await listPreparedProspects(ctx,preparedProspectListInputSchema.parse(parsed.data),authority):await readPreparedProspect(ctx,preparedProspectReadInputSchema.parse(parsed.data),authority);
  // Keep source, device, session and membership locks through the final auth wait.
  const authorized=await authority();
  const wall=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
  return {result,authorized,wall};
 });
 // COMMIT can wait. Publication performs no additional async source/auth work.
 const now=publication.publicationNow(answer.wall),result=answer.result;
 if(!answer.authorized||now===null||!result.ok&&result.reason==='authority_changed')return {status:401,body:{error:'unauthenticated'}};
 if(!result.ok)return {status:409,body:{error:result.reason}};
 const summaries='prospects' in result.value?result.value.prospects:[result.value];
 if(summaries.some(p=>p.validUntil!==null&&Date.parse(p.validUntil)<=now))return {status:409,body:{error:'source_expired'}};
 return {status:200,body:{...result.value,checkedAt:new Date(now).toISOString()}};
}
