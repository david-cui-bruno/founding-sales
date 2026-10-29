import {prospectPriorityRoleSchema} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readRelationships} from '../crm/relationships.ts';
import {readIdentityPerson} from '../crm/identityAccess.ts';
export type PriorityRole=z.infer<typeof prospectPriorityRoleSchema>;
export interface PriorityRoleCandidate{personId:string;personName:string;relationshipId:string;relationshipRevision:number}
/** Reuse canonical identity/source owners; candidate observations never create a Person. */
export async function priorityRoleCandidates(ctx:RepositoryContext,candidateId:string):Promise<{candidates:PriorityRoleCandidate[];hasMore:boolean}>{
 const rows=(await ctx.db.query<{person_id:string}>(`SELECT DISTINCT r.person_id FROM crm_relationships r JOIN firms f ON f.workspace_id=r.workspace_id AND f.id=r.firm_id
 WHERE r.workspace_id=$1 AND f.status='active' AND r.status='current' AND EXISTS(
 SELECT 1 FROM sourcing_admissions a WHERE a.workspace_id=r.workspace_id AND a.candidate_id=$2 AND a.firm_id=r.firm_id AND NOT a.association_review_required)
 ORDER BY r.person_id LIMIT 21`,[ctx.scope.workspaceId,candidateId])).rows;
 const candidates:PriorityRoleCandidate[]=[];
 for(const row of rows.slice(0,20)){
  const person=await readIdentityPerson(ctx,row.person_id);if(!person)continue;
  const relationships=await readRelationships(ctx,{personId:row.person_id,limit:100});
  for(const r of relationships?.relationships??[]){
   if(r.status!=='current'||r.contextReview!=='current'||r.sourceState!=='available'||r.endDate!==null)continue;
   const linked=(await ctx.db.query(`SELECT 1 FROM sourcing_admissions a JOIN firms f ON f.workspace_id=a.workspace_id AND f.id=a.firm_id WHERE a.workspace_id=$1 AND a.candidate_id=$2 AND a.firm_id=$3 AND NOT a.association_review_required AND f.status='active'`,[ctx.scope.workspaceId,candidateId,r.firmId])).rows.length>0;
   if(linked)candidates.push({personId:row.person_id,personName:person.fullName,relationshipId:r.relationshipId,relationshipRevision:r.revision});
   if(candidates.length===20)return {candidates,hasMore:true};
  }
 }
 return {candidates,hasMore:rows.length>20};
}
export async function currentPriorityRoles(ctx:RepositoryContext,candidateId:string,value:unknown):Promise<PriorityRole[]>{
 const parsed=prospectPriorityRoleSchema.array().max(8).safeParse(value);if(!parsed.success||!parsed.data.length)return [];
 const current:PriorityRole[]=[];
 for(const role of parsed.data){
  const integer=BigInt('0x'+role.relationshipId.replaceAll('-',''));
  if(integer===0n)continue;
  const hex=(integer-1n).toString(16).padStart(32,'0'),afterId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const relationships=await readRelationships(ctx,{personId:role.personId,afterId,limit:1});
  const r=relationships?.relationships.find(item=>item.relationshipId===role.relationshipId);
  if(!r||r.revision!==role.relationshipRevision||r.status!=='current'||r.contextReview!=='current'||r.sourceState!=='available'||r.endDate!==null||!await readIdentityPerson(ctx,role.personId))continue;
  const linked=(await ctx.db.query(`SELECT 1 FROM sourcing_admissions a JOIN firms f ON f.workspace_id=a.workspace_id AND f.id=a.firm_id WHERE a.workspace_id=$1 AND a.candidate_id=$2 AND a.firm_id=$3 AND NOT a.association_review_required AND f.status='active'`,[ctx.scope.workspaceId,candidateId,r.firmId])).rows.length>0;
  if(linked)current.push(role);
 }
 return current;
}
