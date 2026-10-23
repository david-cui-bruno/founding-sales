import {isDeepStrictEqual} from 'node:util';
import {candidateAuthorityReadSchema,candidateAuthorityViewSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readCandidateAuthority} from '@fss/domain/sourcing/candidateAuthority.ts';
import {contextForPrincipal,requirePrincipal,type RouteDeps} from './routeSupport.ts';
import type {RouteResult} from './types.ts';
export const CANDIDATE_AUTHORITY_PATH='/sourcing/candidates/authority/read';
export async function routeCandidateAuthority({auth,principal,request}:RouteDeps):Promise<RouteResult>{
 const parsed=candidateAuthorityReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
 const scoped=contextForPrincipal(auth,principal);if(!scoped.ok)return scoped.result;
 if(scoped.context.scope.actor.kind!=='user'||scoped.context.scope.actor.role!=='admin')return {status:403,body:{error:'admin_only'}};
 const answer=await withTransaction(auth.db,()=>readCandidateAuthority(scoped.context,parsed.data));
 // Reauthenticate after transaction/lock waits, including session/device identity.
 const current=await requirePrincipal(auth,request);
 if(!current.ok||!isDeepStrictEqual(current.principal,principal))return {status:401,body:{error:'unauthenticated'}};
 if(!answer.ok)return {status:answer.reason==='admin_only'?403:answer.reason==='candidate_unavailable'?404:409,body:{error:answer.reason}};
 return {status:200,body:candidateAuthorityViewSchema.parse(answer.value)};
}
