import type {z} from 'zod';
import type {askReadSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockIdentityContext,activeIdentityActor} from './identityAccess.ts';

/** Server-defined exact state, bounded display; neither a model nor source text supplies SQL. */
export async function readAsk(context:RepositoryContext,input:z.infer<typeof askReadSchema>){
 if(!await lockIdentityContext(context,{firmIds:[input.scope.firmId]}))return null;
 const count=(await context.db.query<{count:string}>("SELECT count(*)::text AS count FROM opportunities WHERE workspace_id=$1 AND firm_id=$2 AND ($3='all' OR status=$3) AND ($4::timestamptz IS NULL OR opened_at>=$4) AND ($5::timestamptz IS NULL OR opened_at<$5)",[context.scope.workspaceId,input.scope.firmId,input.status,input.scope.from??null,input.scope.to??null])).rows[0]!.count;
 const rows=(await context.db.query<{id:string;firm_id:string;display_name:string|null;status:'open'|'won'|'lost';stage_key:string;opened_at:Date}>(`SELECT o.id,o.firm_id,o.display_name,o.status,p.key AS stage_key,o.opened_at FROM opportunities o JOIN pipeline_stages p ON p.workspace_id=o.workspace_id AND p.id=o.stage_id WHERE o.workspace_id=$1 AND o.firm_id=$2 AND ($3='all' OR o.status=$3) AND ($4::timestamptz IS NULL OR o.opened_at>=$4) AND ($5::timestamptz IS NULL OR o.opened_at<$5) ORDER BY o.opened_at,o.id LIMIT $6`,[context.scope.workspaceId,input.scope.firmId,input.status,input.scope.from??null,input.scope.to??null,input.limit+1])).rows;
 if(!await activeIdentityActor(context))return null;
 return {operation:'opportunities' as const,scope:input.scope,dateBasis:'opportunity_opened_at' as const,count,records:rows.slice(0,input.limit).map(row=>({opportunityId:row.id,firmId:row.firm_id,name:row.display_name,status:row.status,stageKey:row.stage_key,openedAt:row.opened_at.toISOString()})),truncated:rows.length>input.limit,coverage:{scope:'current_permitted_crm_state' as const,acquisition:'unverified' as const,semantic:'not_requested' as const}};
}
