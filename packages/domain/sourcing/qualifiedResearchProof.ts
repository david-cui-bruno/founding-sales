import {createHash} from 'node:crypto';
import {candidateInputSchema,discoveryOriginSchema,qualifiedResearchCandidateSchema,type QualifiedResearchCandidate} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {canonicalWebsite,firmNameKey,websiteDomain,workspaceIndex} from '../crm/import.ts';
import {databaseNow} from '../policy/clock.ts';
import {qualifyEmailCandidate} from '../outreach/selection.ts';
import {readDiscoveryPreparation} from './discoveryPromotion.ts';
import {nativeFirmCitations} from './nativeFirmEligibility.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION,type QualificationRunRow} from './qualificationStore.ts';
export const canonicalResearchValue=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item!==null&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export const researchFingerprint=(value:unknown):string=>createHash('sha256').update(canonicalResearchValue(value)).digest('hex');
export async function researchActor(ctx:RepositoryContext){return ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin'&&await activeIdentityActor(ctx);}
/** Existing CRM identity index includes merge aliases. Any competing name/domain is internal. */
export async function researchIdentity(ctx:RepositoryContext,name:string,website:string):Promise<{firmId:string|null}|null>{
 const index=await workspaceIndex(ctx),domain=websiteDomain(website);
 const ids=[...new Set([...(index.byName.get(firmNameKey(name))??[]),...(domain===null?[]:index.byDomain.get(domain)??[])].map(f=>f.id))];
 if(ids.length>1)return null;
 if(!ids.length)return {firmId:null};
 const firm=(await ctx.db.query<{id:string;name:string;website:string|null;assigned_user_id:string;status:string}>('SELECT id,name,website,assigned_user_id,status FROM firms WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,ids[0]])).rows[0];
 return firm&&ctx.scope.actor.kind==='user'&&firm.status==='active'&&firm.assigned_user_id===ctx.scope.actor.userId&&firm.name===name.trim().replaceAll(/\s+/gu,' ')&&firm.website===canonicalWebsite(website)?{firmId:firm.id}:null;
}
/** Reuses preparation and native citation policy, never qualification admission. */
export async function readQualifiedResearchCandidate(ctx:RepositoryContext,discoveryCandidateId:string):Promise<QualifiedResearchCandidate|null>{
 if(!await researchActor(ctx))return null;
 const row=(await ctx.db.query<{id:string;provider:string;release:string;record_id:string;legacy_candidate_id:string;revision:number;qualification_blocked:boolean;payload:unknown}>(`SELECT p.id,p.provider,p.release,p.record_id,p.legacy_candidate_id,c.revision,c.qualification_blocked,c.payload FROM sourcing_discovery_promotions p JOIN sourcing_candidates c ON c.workspace_id=p.workspace_id AND c.id=p.legacy_candidate_id WHERE p.workspace_id=$1 AND p.raw_candidate_id=$2`,[ctx.scope.workspaceId,discoveryCandidateId])).rows[0];
 if(!row||row.qualification_blocked)return null;
 const preparation=await readDiscoveryPreparation(ctx,row.id),candidate=candidateInputSchema.safeParse(row.payload);
 if(!preparation||!candidate.success)return null;
 const originSql='SELECT o.source,o.source_metadata,o.licenses,o.notices,r.qualification_blocked FROM sourcing_candidate_discovery_origins o JOIN sourcing_candidates r ON r.workspace_id=o.workspace_id AND r.id=o.candidate_id WHERE o.workspace_id=$1 AND o.candidate_id=$2 AND o.provider=$3 AND o.release=$4 AND o.record_id=$5';
 const originArgs=[ctx.scope.workspaceId,discoveryCandidateId,row.provider,row.release,row.record_id];
 const origin=(await ctx.db.query<{qualification_blocked:boolean;source:unknown;source_metadata:unknown;licenses:unknown;notices:unknown}>(originSql,originArgs)).rows[0];
 if(!origin||origin.qualification_blocked||!discoveryOriginSchema.safeParse({source:origin.source,sourceMetadata:origin.source_metadata,licenses:origin.licenses,notices:origin.notices}).success)return null;
 const run=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 1',[ctx.scope.workspaceId,row.legacy_candidate_id])).rows[0];
 if(!run||run.candidate_revision!==row.revision||run.prompt_version!==QUALIFICATION_PROMPT_VERSION||run.policy_version!==QUALIFICATION_POLICY_VERSION||run.reason!==null||!['review','eligible','admitted'].includes(run.state))return null;
 const now=await databaseNow(ctx),proof=nativeFirmCitations({candidate:candidate.data,facts:run.facts,observations:run.observations,now});
 if('status' in proof||!await researchIdentity(ctx,candidate.data.firmName,candidate.data.website))return null;
 const citations=proof.citations.map(c=>{const source=run.observations.find(s=>s.id===c.observationId)!;return {...c,url:source.url,contentHash:source.contentHash,retrievedAt:source.retrievedAt,quote:source.blocks.find(b=>b.id===c.blockId)!.text};});
 const selection={discoveryCandidateId,discoveryRevision:preparation.discoveryRevision,candidateId:row.legacy_candidate_id,candidateRevision:row.revision,runId:run.id};
 const source={provider:row.provider,release:row.release,recordId:row.record_id};
 const identity={status:'resolved' as const,name:candidate.data.firmName,website:candidate.data.website,locality:candidate.data.locality,region:candidate.data.region};
 const email=qualifyEmailCandidate({identity,facts:run.facts,observations:run.observations,now});
 const evidenceFingerprint=researchFingerprint({selection,promotionId:row.id,source,origin,candidate:candidate.data,nativePolicyVersion:'native-firm-eligibility-v1',policyVersion:run.policy_version,promptVersion:run.prompt_version,facts:run.facts,observations:run.observations});
 const value=qualifiedResearchCandidateSchema.parse({selection,promotionId:row.id,source,firmName:candidate.data.firmName,website:candidate.data.website,locality:candidate.data.locality,region:candidate.data.region,policyVersion:'native-firm-eligibility-v1',evidenceFingerprint,validUntil:proof.validUntil,citations,emailFit:email.decision==='eligible'?'eligible':'unresolved',channelAuthority:'not_granted',maintenanceNeed:'not_established'});
 const latest=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 1',[ctx.scope.workspaceId,row.legacy_candidate_id])).rows[0];
 const current=await readDiscoveryPreparation(ctx,row.id);
 const currentCandidate=(await ctx.db.query<{revision:number;qualification_blocked:boolean;payload:unknown}>('SELECT revision,qualification_blocked,payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,row.legacy_candidate_id])).rows[0];
 const currentOrigin=(await ctx.db.query(originSql,originArgs)).rows[0];
 return current&&canonicalResearchValue(current)===canonicalResearchValue(preparation)&&currentCandidate?.revision===row.revision&&!currentCandidate.qualification_blocked&&canonicalResearchValue(currentCandidate.payload)===canonicalResearchValue(row.payload)&&canonicalResearchValue(currentOrigin)===canonicalResearchValue(origin)&&canonicalResearchValue(latest)===canonicalResearchValue(run)&&await researchIdentity(ctx,candidate.data.firmName,candidate.data.website)&&await researchActor(ctx)&&Date.parse(await databaseNow(ctx))<Date.parse(proof.validUntil)?value:null;
}
export async function listQualifiedResearchCandidates(ctx:RepositoryContext,input:{afterId?:string|undefined}){
 if(!await researchActor(ctx))return {candidates:[],nextAfterId:null};
 const rows=(await ctx.db.query<{raw_candidate_id:string}>('SELECT raw_candidate_id FROM sourcing_discovery_promotions WHERE workspace_id=$1 AND ($2::uuid IS NULL OR raw_candidate_id>$2) ORDER BY raw_candidate_id LIMIT 101',[ctx.scope.workspaceId,input.afterId??null])).rows;
 const candidates:QualifiedResearchCandidate[]=[];let cursor:string|null=null;
 for(const row of rows.slice(0,100)){cursor=row.raw_candidate_id;const value=await readQualifiedResearchCandidate(ctx,cursor);if(value)candidates.push(value);if(candidates.length===25)break;}
 return {candidates,nextAfterId:cursor&&(rows.length>100||cursor!==rows.at(-1)?.raw_candidate_id)?cursor:null};
}
