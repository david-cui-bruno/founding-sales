import {randomUUID} from 'node:crypto';
import {targetingRanks,targetingProposalSchema,targetingApplySchema,type TargetingPolicy} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {DISCOVERY_QUERIES} from './discoveryQueries.ts';
import type {SourcingResult} from './qualificationStore.ts';
const initial=():TargetingPolicy=>({version:'targeting-v1',queries:DISCOVERY_QUERIES.map(q=>({...q})),rankOrder:[...targetingRanks]});
export async function readTargetingPolicy(ctx:RepositoryContext):Promise<TargetingPolicy>{
 const row=(await ctx.db.query<{version:string;queries:TargetingPolicy['queries'];rank_order:string[]}>(`SELECT v.version,v.queries,v.rank_order FROM sourcing_discovery_settings s JOIN sourcing_targeting_versions v ON v.workspace_id=s.workspace_id AND v.version=s.targeting_version WHERE s.workspace_id=$1`,[ctx.scope.workspaceId])).rows[0];
 return row?{version:row.version,queries:row.queries,rankOrder:row.rank_order}:initial();
}
/** Caller transaction; discovery already locks settings before its shared budget. */
export async function ensureTargetingPolicy(ctx:RepositoryContext):Promise<TargetingPolicy>{
 const w=ctx.scope.workspaceId,p=initial();
 await ctx.db.query('INSERT INTO sourcing_discovery_settings(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[w]);
 await ctx.db.query('SELECT workspace_id FROM sourcing_discovery_settings WHERE workspace_id=$1 FOR UPDATE',[w]);
 await ctx.db.query('INSERT INTO sourcing_targeting_versions(workspace_id,version,queries,rank_order) VALUES($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT DO NOTHING',[w,p.version,JSON.stringify(p.queries),JSON.stringify(p.rankOrder)]);
 await ctx.db.query('UPDATE sourcing_discovery_settings SET targeting_version=$2 WHERE workspace_id=$1 AND targeting_version IS NULL',[w,p.version]);
 return readTargetingPolicy(ctx);
}
export async function saveTargetingProposal(ctx:RepositoryContext,input:z.infer<typeof targetingProposalSchema>):Promise<SourcingResult<{id:string;revision:number}>>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')return {ok:false,reason:'admin_only'};
 const parsed=targetingProposalSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const policy=await ensureTargetingPolicy(ctx);if(policy.version!==input.basePolicyVersion)return {ok:false,reason:'policy_changed'};
 const queries=new Map(policy.queries.map(q=>[q.id,q]));for(const q of parsed.data.queryChanges)queries.set(q.id,q);if(queries.size>30)return {ok:false,reason:'too_many_queries'};
 if(input.evidenceIds.length){const matched=await ctx.db.query<{id:string}>(`SELECT id FROM sourcing_feedback WHERE workspace_id=$1 AND id=ANY($2::uuid[]) UNION SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=ANY($2::uuid[]) UNION SELECT id FROM sourcing_attributions WHERE workspace_id=$1 AND id=ANY($2::uuid[]) UNION SELECT id FROM funnel_facts WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,[ctx.scope.workspaceId,input.evidenceIds]);if(matched.rows.length!==input.evidenceIds.length)return {ok:false,reason:'evidence_unavailable'};}
 const row=(await ctx.db.query<{id:string;revision:number}>('INSERT INTO sourcing_targeting_proposals(workspace_id,base_version,changes,created_by) VALUES($1,$2,$3::jsonb,$4) RETURNING id,revision',[ctx.scope.workspaceId,policy.version,JSON.stringify(parsed.data),ctx.scope.actor.userId])).rows[0]!;
 await recordCrmAuditEvent(ctx,{action:'sourcing.targeting_proposed',subjectKind:'sourcing_targeting',subjectId:row.id,detail:{baseVersion:policy.version,revision:row.revision}});return {ok:true,value:row};
}
export async function applyTargetingProposal(ctx:RepositoryContext,input:{id:string;expectedRevision:number}):Promise<SourcingResult<{policyVersion:string}>>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')return {ok:false,reason:'admin_only'};
 if(!targetingApplySchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 const policy=await ensureTargetingPolicy(ctx),w=ctx.scope.workspaceId;
 const row=(await ctx.db.query<{base_version:string;revision:number;changes:z.infer<typeof targetingProposalSchema>;applied_version:string|null}>('SELECT base_version,revision,changes,applied_version FROM sourcing_targeting_proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.id])).rows[0];
 if(!row)return {ok:false,reason:'not_found'};if(row.revision!==input.expectedRevision||row.applied_version!==null)return {ok:false,reason:'proposal_changed'};if(row.base_version!==policy.version)return {ok:false,reason:'policy_changed'};
 const parsed=targetingProposalSchema.safeParse(row.changes);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const queries=new Map(policy.queries.map(q=>[q.id,q]));for(const query of parsed.data.queryChanges)queries.set(query.id,query);
 const version=`targeting-${randomUUID()}`;
 await ctx.db.query('INSERT INTO sourcing_targeting_versions(workspace_id,version,queries,rank_order) VALUES($1,$2,$3::jsonb,$4::jsonb)',[w,version,JSON.stringify([...queries.values()]),JSON.stringify(parsed.data.rankOrder)]);
 await ctx.db.query('UPDATE sourcing_targeting_proposals SET applied_version=$3,applied_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2',[w,input.id,version]);
 await ctx.db.query('UPDATE sourcing_discovery_settings SET targeting_version=$2 WHERE workspace_id=$1',[w,version]);
 await recordCrmAuditEvent(ctx,{action:'sourcing.targeting_applied',subjectKind:'sourcing_targeting',subjectId:input.id,detail:{policyVersion:version,revision:row.revision+1}});
 return {ok:true,value:{policyVersion:version}};
}
export async function readTargetingView(ctx:RepositoryContext){
 const canEdit=ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin';
 const rows=canEdit?(await ctx.db.query<{id:string;revision:number;changes:z.infer<typeof targetingProposalSchema>;applied_version:string|null}>('SELECT id,revision,changes,applied_version FROM sourcing_targeting_proposals WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30',[ctx.scope.workspaceId])).rows:[];
 return {policy:await readTargetingPolicy(ctx),proposals:rows.map(r=>({id:r.id,revision:r.revision,changes:r.changes,appliedVersion:r.applied_version})),canEdit};
}
