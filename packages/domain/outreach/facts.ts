import {saveAnswerBlockSchema,type AnswerBlock,type SaveAnswerBlock} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
type Row = {block_id:string;version:number;kind:AnswerBlock['kind'];text:string;approved_at:Date|string|null;retired_at:Date|string|null;current_version:number}
const view=(r:Row):AnswerBlock=>({id:r.block_id,version:r.version,kind:r.kind,text:r.text,approvedAt:r.approved_at===null?null:new Date(r.approved_at).toISOString(),retiredAt:r.retired_at===null?null:new Date(r.retired_at).toISOString()});
const admin=(c:RepositoryContext)=>c.scope.actor.kind==='user'&&c.scope.actor.role==='admin';
async function read(ctx:RepositoryContext,id:string,version:number):Promise<Row|null>{return (await ctx.db.query<Row>(`SELECT v.*,b.current_version FROM outreach_answer_block_versions v JOIN outreach_answer_blocks b ON b.workspace_id=v.workspace_id AND b.id=v.block_id WHERE v.workspace_id=$1 AND v.block_id=$2 AND v.version=$3`,[ctx.scope.workspaceId,id,version])).rows[0]??null;}
export async function saveAnswerBlock(ctx:RepositoryContext,input:SaveAnswerBlock):Promise<Result<AnswerBlock>>{
 if(!admin(ctx)||ctx.scope.actor.kind!=='user')return {ok:false,reason:'admin_required'};
 const parsed=saveAnswerBlockSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 await lockSendGateForStopFact(ctx);
 let id=input.id,version=1;
 if(id){const parent=(await ctx.db.query<{current_version:number}>('SELECT current_version FROM outreach_answer_blocks WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,id])).rows[0];if(!parent)return {ok:false,reason:'not_found'};if(parent.current_version!==input.expectedVersion)return {ok:false,reason:'stale_version'};version=parent.current_version+1;await ctx.db.query('UPDATE outreach_answer_blocks SET current_version=$3 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id,version]);}
 else{id=(await ctx.db.query<{id:string}>('INSERT INTO outreach_answer_blocks(workspace_id,current_version) VALUES($1,1) RETURNING id',[ctx.scope.workspaceId])).rows[0]!.id;}
 await ctx.db.query('INSERT INTO outreach_answer_block_versions(workspace_id,block_id,version,kind,text,created_by) VALUES($1,$2,$3,$4,$5,$6)',[ctx.scope.workspaceId,id,version,parsed.data.kind,parsed.data.text,ctx.scope.actor.userId]);
 await recordCrmAuditEvent(ctx,{action:'outreach.answer_block_saved',subjectKind:'answer_block',subjectId:id,detail:{version,kind:input.kind}});
 return {ok:true,value:view((await read(ctx,id,version))!)};
}
async function changeApproval(ctx:RepositoryContext,input:{id:string;version:number},retire:boolean):Promise<Result<AnswerBlock>>{
 if(!admin(ctx)||ctx.scope.actor.kind!=='user')return {ok:false,reason:'admin_required'};
 await lockSendGateForStopFact(ctx);
 const parent=(await ctx.db.query<{current_version:number}>('SELECT current_version FROM outreach_answer_blocks WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,input.id])).rows[0];
 if(!parent)return {ok:false,reason:'not_found'};if(parent.current_version!==input.version)return {ok:false,reason:'stale_version'};
 const row=await read(ctx,input.id,input.version);if(!row)return {ok:false,reason:'not_found'};
 if(!retire&&row.retired_at)return {ok:false,reason:'block_retired'};
 if(retire)await ctx.db.query('UPDATE outreach_answer_block_versions SET retired_at=COALESCE(retired_at,now()) WHERE workspace_id=$1 AND block_id=$2 AND version=$3',[ctx.scope.workspaceId,input.id,input.version]);
 else await ctx.db.query('UPDATE outreach_answer_block_versions SET approved_at=COALESCE(approved_at,now()),approved_by=COALESCE(approved_by,$4) WHERE workspace_id=$1 AND block_id=$2 AND version=$3',[ctx.scope.workspaceId,input.id,input.version,ctx.scope.actor.userId]);
 await recordCrmAuditEvent(ctx,{action:retire?'outreach.answer_block_retired':'outreach.answer_block_approved',subjectKind:'answer_block',subjectId:input.id,detail:{version:input.version}});
 return {ok:true,value:view((await read(ctx,input.id,input.version))!)};
}
export const approveAnswerBlock=(ctx:RepositoryContext,input:{id:string;version:number})=>changeApproval(ctx,input,false);
export const retireAnswerBlock=(ctx:RepositoryContext,input:{id:string;version:number})=>changeApproval(ctx,input,true);
export async function readApprovedAnswerBlocks(ctx:RepositoryContext,refs:readonly {id:string;version:number}[]):Promise<Result<AnswerBlock[]>>{
 if(!refs.length||refs.length>20)return {ok:false,reason:'invalid_input'};
 const blocks:AnswerBlock[]=[];
 for(const ref of refs){const row=await read(ctx,ref.id,ref.version);if(!row)return {ok:false,reason:'not_found'};if(row.current_version!==ref.version)return {ok:false,reason:'block_changed'};if(row.retired_at)return {ok:false,reason:'block_retired'};if(!row.approved_at)return {ok:false,reason:'block_unapproved'};blocks.push(view(row));}
 return {ok:true,value:blocks};
}
export async function listAnswerBlocks(ctx:RepositoryContext,afterId?:string):Promise<AnswerBlock[]>{
 if(!admin(ctx))return [];
 return (await ctx.db.query<Row>(`SELECT v.*,b.current_version FROM outreach_answer_blocks b JOIN outreach_answer_block_versions v ON v.workspace_id=b.workspace_id AND v.block_id=b.id AND v.version=b.current_version WHERE b.workspace_id=$1 AND ($2::uuid IS NULL OR b.id>$2) ORDER BY b.id LIMIT 50`,[ctx.scope.workspaceId,afterId??null])).rows.map(view);
}
