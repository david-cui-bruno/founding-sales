import {qualifiedResearchFirmSchema,type QualifiedResearchSelection,type QualifiedResearchFirm} from '@fss/contracts';
import {admitQualifiedResearchFirmToCampaign} from '../outreach/emailCampaignAdmission.ts';
import {lockCurrentEmailCampaign} from '../outreach/emailCampaignAuthority.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {createFirm,loadFirmForUpdate} from '../crm/firms.ts';
import {canonicalWebsite} from '../crm/import.ts';
import {identityFold} from './nativeFirmEligibility.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {lockTodayForFirmChange} from '../today/build.ts';
import {linkDiscoveryResearchFirm,readCurrentDiscoveryResearchFirm} from './discoveryResearchFirm.ts';
import {canonicalResearchValue,readQualifiedResearchCandidate,researchActor,researchIdentity} from './qualifiedResearchProof.ts';
export {listQualifiedResearchCandidates} from './qualifiedResearchProof.ts';
export async function readQualifiedResearchFirm(ctx:RepositoryContext,firmId:string):Promise<QualifiedResearchFirm|null>{
 const lineage=await readCurrentDiscoveryResearchFirm(ctx,{firmId});if(!lineage)return null;
 const proof=await readQualifiedResearchCandidate(ctx,lineage.discoveryCandidateId);if(!proof)return null;
 if((lineage.firm.locality!==null&&identityFold(lineage.firm.locality)!==identityFold(proof.locality))||(lineage.firm.region_code!==null&&lineage.firm.region_code!==proof.region))return null;
 const current=await readCurrentDiscoveryResearchFirm(ctx,{firmId});
 if(!current||canonicalResearchValue(current)!==canonicalResearchValue(lineage)||!await researchActor(ctx))return null;
 return qualifiedResearchFirmSchema.parse({...proof,firmId,ownerUserId:current.firm.assigned_user_id,nextStep:'prepare_discovery_conversation',question:'What would be useful to learn about this firm before considering a discovery conversation?'});
}
type Result={ok:true;value:{firmId:string}}|{ok:false;reason:string};
export async function createQualifiedResearchFirm(ctx:RepositoryContext,input:QualifiedResearchSelection,currentAuthority:()=>Promise<boolean>=async()=>researchActor(ctx)):Promise<Result>{
 if(!await researchActor(ctx))return {ok:false,reason:'admin_only'};
 await ctx.db.query('SAVEPOINT qualified_research_firm');
 try{let result=await create(ctx,input,currentAuthority);if(result.ok&&!await currentAuthority())result={ok:false,reason:'authority_changed'};if(!result.ok)await ctx.db.query('ROLLBACK TO SAVEPOINT qualified_research_firm');await ctx.db.query('RELEASE SAVEPOINT qualified_research_firm');return result;}
 catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT qualified_research_firm');await ctx.db.query('RELEASE SAVEPOINT qualified_research_firm');throw error;}
}
async function create(ctx:RepositoryContext,input:QualifiedResearchSelection,currentAuthority:()=>Promise<boolean>):Promise<Result>{
 await lockSendGateForStopFact(ctx);await lockTodayForFirmChange(ctx);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-identity:${ctx.scope.workspaceId}`]);
 await lockCurrentEmailCampaign(ctx);
 if(!await currentAuthority())return {ok:false,reason:'authority_changed'};
 const initial=await readQualifiedResearchCandidate(ctx,input.discoveryCandidateId);
 if(!initial||canonicalResearchValue(initial.selection)!==canonicalResearchValue(input))return {ok:false,reason:'qualification_changed'};
 const identity=await researchIdentity(ctx,initial.firmName,initial.website);if(!identity)return {ok:false,reason:'firm_identity_ambiguous'};
 let firm=identity.firmId?await loadFirmForUpdate(ctx,identity.firmId):null;
 if(identity.firmId&&!firm)return {ok:false,reason:'firm_changed'};
 // A new Firm is acquired before candidate/run locks, like ordinary admission.
 if(!firm){
  if(ctx.scope.actor.kind!=='user')return {ok:false,reason:'admin_only'};
  const made=await createFirm(ctx,{name:initial.firmName.trim().replaceAll(/\s+/gu,' '),website:canonicalWebsite(initial.website)??initial.website,locality:initial.locality,regionCode:initial.region,assignedUserId:ctx.scope.actor.userId});
  if(!made.ok)return made;firm=made.value;
 }
 await ctx.db.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[ctx.scope.workspaceId,[input.discoveryCandidateId,input.candidateId]]);
 await ctx.db.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,input.runId]);
 const current=await readQualifiedResearchCandidate(ctx,input.discoveryCandidateId);
 if(!current||canonicalResearchValue(current)!==canonicalResearchValue(initial)||!await researchActor(ctx))return {ok:false,reason:'qualification_changed'};
 const linked=await linkDiscoveryResearchFirm(ctx,{discoveryCandidateId:input.discoveryCandidateId,expectedRevision:input.discoveryRevision,qualificationCandidateId:input.candidateId,firmId:firm.id});
 if(!linked.ok)return linked;
 const view=await readQualifiedResearchFirm(ctx,firm.id);if(!view)return {ok:false,reason:'research_firm_unavailable'};
 await admitQualifiedResearchFirmToCampaign(ctx,firm.id,currentAuthority);
 return {ok:true,value:{firmId:firm.id}};
}
