import type {z} from 'zod';
import {type askExplicitCorpusScopeSchema,crmClaimContextSchema,crmOriginalAccessClosureSchema,type CrmOriginalAccessClosure} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readCrmConflict} from './evidenceDecisions.ts';

/** Scope metadata is filtered before the existing conflict reader may lock or read originals. */
export async function readAskInputConflicts(context:RepositoryContext,scope:z.infer<typeof askExplicitCorpusScopeSchema>,access:CrmOriginalAccessClosure){
 const candidates=(await context.db.query<{id:string}>(`SELECT DISTINCT g.id FROM crm_claim_conflicts g JOIN crm_claim_conflict_members m ON m.workspace_id=g.workspace_id AND m.conflict_id=g.id JOIN crm_claim_review_anchors a ON a.workspace_id=m.workspace_id AND a.id=m.anchor_id WHERE g.workspace_id=$1 AND a.source_id=ANY($2::uuid[]) AND NOT EXISTS(SELECT 1 FROM crm_claim_conflict_members hm JOIN crm_claim_review_anchors ha ON ha.workspace_id=hm.workspace_id AND ha.id=hm.anchor_id WHERE hm.workspace_id=g.workspace_id AND hm.conflict_id=g.id AND (
 NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS selected(kind text,"sourceId" uuid,revision int,"contentHash" text) WHERE selected.kind=ha.source_kind AND selected."sourceId"=ha.source_id AND selected.revision=ha.source_revision AND selected."contentHash"=ha.source_hash)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(ha.original_access_closure->'firmIds') entry WHERE entry::uuid<>ALL($4::uuid[]))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(ha.original_access_closure->'personIds') entry WHERE entry::uuid<>ALL($5::uuid[]))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(ha.context_snapshot->'firmIds') entry WHERE entry::uuid<>ALL($4::uuid[]))
 OR ha.context_snapshot->>'personId' IS NOT NULL AND (ha.context_snapshot->>'personId')::uuid<>ALL($5::uuid[])
 )) ORDER BY g.id LIMIT 101`,[context.scope.workspaceId,scope.sources.map(source=>source.sourceId),JSON.stringify(scope.sources),access.firmIds,access.personIds])).rows;
 if(candidates.length>100)return null;
 const conflicts:{conflictId:string;revision:number;state:'open';resolution:null}[]=[];
 for(const candidate of candidates){
  if((await context.db.query('SELECT id FROM crm_claim_conflicts WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,candidate.id])).rows.length!==1)continue;
  const anchors=(await context.db.query<{source_kind:string;source_id:string;source_revision:number;source_hash:string;context_snapshot:unknown;original_access_closure:unknown}>(`SELECT DISTINCT a.id,a.source_kind,a.source_id,a.source_revision,a.source_hash,a.context_snapshot,a.original_access_closure FROM crm_claim_conflict_members m JOIN crm_claim_review_anchors a ON a.workspace_id=m.workspace_id AND a.id=m.anchor_id WHERE m.workspace_id=$1 AND m.conflict_id=$2 ORDER BY a.id LIMIT 501`,[context.scope.workspaceId,candidate.id])).rows;
  if(anchors.length>500)return null;
  if(anchors.length<2||anchors.some(anchor=>{
   if(!scope.sources.some(source=>source.kind===anchor.source_kind&&source.sourceId===anchor.source_id&&source.revision===anchor.source_revision&&source.contentHash===anchor.source_hash))return true;
   const original=crmOriginalAccessClosureSchema.safeParse(anchor.original_access_closure),current=crmClaimContextSchema.safeParse(anchor.context_snapshot);
   return !original.success||!current.success||original.data.firmIds.some(id=>!access.firmIds.includes(id))||original.data.personIds.some(id=>!access.personIds.includes(id))||current.data.firmIds.some(id=>!access.firmIds.includes(id))||current.data.personId!==null&&!access.personIds.includes(current.data.personId);
  }))continue;
  const current=await readCrmConflict(context,{conflictId:candidate.id,limit:1});
  if(current===null||current.state!=='open')continue;
  conflicts.push({conflictId:current.conflictId,revision:current.revision,state:'open',resolution:null});
  if(conflicts.length>10)return null;
 }
 return conflicts;
}
