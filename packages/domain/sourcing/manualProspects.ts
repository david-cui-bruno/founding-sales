import {isDeepStrictEqual} from 'node:util';
import {manualProspectListInputSchema,manualProspectListSchema,manualProspectFeedbackInputSchema,type manualProspectFeedbackSavedSchema} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {manualProspectRows,MANUAL_PROSPECT_ROWS_SQL} from './manualProspectRows.ts';
import {projectManualProspect,type ManualProspectRow} from './manualProspectProjection.ts';

type Result<T>={ok:true;value:T}|{ok:false;reason:string};
const refuse=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
async function admin(ctx:RepositoryContext):Promise<boolean>{
 return ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin'&&await activeIdentityActor(ctx);
}
/** Caller owns transaction and authenticated principal fence. No external IO. */
export async function listManualProspects(ctx:RepositoryContext,input:z.infer<typeof manualProspectListInputSchema>,authority:()=>Promise<boolean>=async()=>true):Promise<Result<z.infer<typeof manualProspectListSchema>>>{
 if(!await admin(ctx))return refuse('admin_only');
 if(!manualProspectListInputSchema.safeParse(input).success)return refuse('invalid_input');
 const rows=await manualProspectRows(ctx,input.state,input.offset);
 if(!await authority()||!await admin(ctx)||!isDeepStrictEqual(rows,await manualProspectRows(ctx,input.state,input.offset)))return refuse('authority_changed');
 return {ok:true,value:manualProspectListSchema.parse({prospects:rows.slice(0,50).flatMap(row=>{const p=projectManualProspect(row);return p?[p]:[];}),hasMore:rows.length>50})};
}
/** Manual state is not canonical candidate review, qualification or channel suppression.
 * Candidate lock precedes live membership and session revalidation after waits.
 */
export async function recordManualProspectFeedback(ctx:RepositoryContext,input:z.infer<typeof manualProspectFeedbackInputSchema>,authority:()=>Promise<boolean>=async()=>true):Promise<Result<z.infer<typeof manualProspectFeedbackSavedSchema>>>{
 if(!await admin(ctx)||ctx.scope.actor.kind!=='user')return refuse('admin_only');
 if(!manualProspectFeedbackInputSchema.safeParse(input).success)return refuse('invalid_input');
 const w=ctx.scope.workspaceId;
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${w}`]);
 const candidate=(await ctx.db.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.candidateId])).rows[0];
 if(!candidate)return refuse('candidate_unavailable');
 if(candidate.revision!==input.expectedRevision)return refuse('candidate_changed');
 await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[w,ctx.scope.actor.userId]);
 if(!await authority()||!await admin(ctx))return refuse('authority_changed');
 const row=(await ctx.db.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_PROSPECT_ROWS_SQL}) visible WHERE id=$3`,[w,'all',input.candidateId])).rows[0];
 if(!row||!projectManualProspect(row))return refuse('candidate_unavailable');
 await ctx.db.query(`INSERT INTO sourcing_manual_prospect_states(workspace_id,candidate_id,candidate_revision,state) VALUES($1,$2,$3,$4)
 ON CONFLICT(workspace_id,candidate_id) DO UPDATE SET candidate_revision=EXCLUDED.candidate_revision,state=EXCLUDED.state,updated_at=clock_timestamp()`,[w,input.candidateId,input.expectedRevision,input.state]);
 return {ok:true,value:{candidateId:input.candidateId,revision:input.expectedRevision,state:input.state}};
}
