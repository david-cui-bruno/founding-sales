import {discoveryResearchFirmLinkInputSchema,discoveryResearchFirmLinkSavedSchema,type CandidateInput} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {loadFirmForUpdate} from '../crm/firms.ts';
import {readDiscoveryPreparation,discoveryPreparationMatches} from './discoveryPromotion.ts';

type Input=z.infer<typeof discoveryResearchFirmLinkInputSchema>;
type Saved=z.infer<typeof discoveryResearchFirmLinkSavedSchema>;
type Result={ok:true;value:{promotionId:string;alreadyLinked:boolean}}|{ok:false;reason:string};
const refused=(reason:string):Result=>({ok:false,reason});

/** Links only a separately, explicitly created ordinary CRM research draft.
 * No routes, contacts, fit/identity facts, admission or channel activation are created. */
export async function linkDiscoveryResearchFirm(ctx:RepositoryContext,input:Input):Promise<Result> {
 if(!decideAdminOnly(ctx).permitted||ctx.scope.actor.kind!=='user')return refused('admin_only');
 const parsed=discoveryResearchFirmLinkInputSchema.safeParse(input);if(!parsed.success)return refused('invalid_input');
 const w=ctx.scope.workspaceId,value=parsed.data;
 // Firm before candidate matches admission's identity lock ordering. This command
 // never refreshes Today or creates work: normal Add firm already did that.
 const firm=await loadFirmForUpdate(ctx,value.firmId);if(!firm)return refused('not_found');
 if(firm.status!=='active'||firm.assigned_user_id!==ctx.scope.actor.userId)return refused('firm_assigned_elsewhere');
 const raw=(await ctx.db.query<{payload:unknown;revision:number;status:string}>('SELECT payload,revision,status FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,value.discoveryCandidateId])).rows[0];
 const legacy=(await ctx.db.query<{payload:CandidateInput}>('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,value.qualificationCandidateId])).rows[0];
 if(!raw||!legacy||raw.revision!==value.expectedRevision||raw.status==='dismissed'||!discoveryPreparationMatches(raw.payload,legacy.payload))return refused('candidate_changed');
 const promotion=(await ctx.db.query<{id:string}>('SELECT id FROM sourcing_discovery_promotions WHERE workspace_id=$1 AND raw_candidate_id=$2 AND raw_candidate_revision=$3 AND legacy_candidate_id=$4 FOR UPDATE',[w,value.discoveryCandidateId,value.expectedRevision,value.qualificationCandidateId])).rows[0];
 if(!promotion)return refused('preparation_unavailable');
 const prepared=await readDiscoveryPreparation(ctx,promotion.id);if(!prepared)return refused('preparation_unavailable');
 if(firm.name!==legacy.payload.firmName||firm.website!==legacy.payload.website)return refused('firm_identity_mismatch');
 // Even exact spelling/domain duplicates require explicit resolution, never choose
 // one silently. The normal Add firm command uses its own duplicate policy too.
 const matches=(await ctx.db.query<{id:string}>(`SELECT id FROM firms WHERE workspace_id=$1 AND status='active' AND (lower(trim(name))=lower(trim($2)) OR website=$3) ORDER BY id`,[w,firm.name,firm.website])).rows;
 if(matches.length!==1||matches[0]?.id!==firm.id)return refused('firm_identity_ambiguous');
 const previous=(await ctx.db.query<{firm_id:string}>('SELECT firm_id FROM sourcing_discovery_research_firms WHERE workspace_id=$1 AND promotion_id=$2',[w,promotion.id])).rows[0];
 if(previous)return previous.firm_id===firm.id?{ok:true,value:{promotionId:promotion.id,alreadyLinked:true}}:refused('research_firm_conflict');
 await ctx.db.query('INSERT INTO sourcing_discovery_research_firms(workspace_id,promotion_id,firm_id) VALUES($1,$2,$3)',[w,promotion.id,firm.id]);
 return {ok:true,value:{promotionId:promotion.id,alreadyLinked:false}};
}

export async function readDiscoveryResearchFirm(ctx:RepositoryContext,promotionId:string,alreadyLinked=true):Promise<Saved|null> {
 if(!decideAdminOnly(ctx).permitted||ctx.scope.actor.kind!=='user')return null;
 const prepared=await readDiscoveryPreparation(ctx,promotionId);if(!prepared)return null;
 const row=(await ctx.db.query<{firm_id:string}>(`SELECT l.firm_id FROM sourcing_discovery_research_firms l JOIN sourcing_discovery_promotions p ON p.workspace_id=l.workspace_id AND p.id=l.promotion_id JOIN firms f ON f.workspace_id=l.workspace_id AND f.id=l.firm_id AND f.status='active' AND f.assigned_user_id=$3 JOIN sourcing_candidates c ON c.workspace_id=p.workspace_id AND c.id=p.legacy_candidate_id AND c.status<>'dismissed' AND c.payload->>'firmName'=f.name AND c.payload->>'website'=f.website JOIN sourcing_candidates r ON r.workspace_id=p.workspace_id AND r.id=p.raw_candidate_id AND r.revision=p.raw_candidate_revision AND r.status<>'dismissed' AND r.payload->'row'->>'firmName'=c.payload->>'firmName' AND r.payload->'row'->>'website'=c.payload->>'website' AND r.payload->'row'->>'locality'=c.payload->>'locality' AND r.payload->'row'->>'region'=c.payload->>'region' JOIN sourcing_candidate_discovery_origins o ON o.workspace_id=p.workspace_id AND o.candidate_id=p.raw_candidate_id AND o.provider=p.provider AND o.release=p.release AND o.record_id=p.record_id WHERE l.workspace_id=$1 AND l.promotion_id=$2`,[ctx.scope.workspaceId,promotionId,ctx.scope.actor.userId])).rows[0];
 return row?discoveryResearchFirmLinkSavedSchema.parse({discoveryCandidateId:prepared.discoveryCandidateId,qualificationCandidateId:prepared.qualificationCandidateId,firmId:row.firm_id,alreadyLinked,nextAction:'review_firm_research',qualified:false,admissionAuthorized:false,runtimeCallable:false}):null;
}

export async function readDiscoveryResearchFirmForCandidate(ctx:RepositoryContext,candidateId:string):Promise<Saved|null> {
 if(!decideAdminOnly(ctx).permitted)return null;
 const p=(await ctx.db.query<{id:string}>('SELECT id FROM sourcing_discovery_promotions WHERE workspace_id=$1 AND raw_candidate_id=$2',[ctx.scope.workspaceId,candidateId])).rows[0];
 return p?readDiscoveryResearchFirm(ctx,p.id):null;
}
