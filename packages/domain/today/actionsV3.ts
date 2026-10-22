import {isDeepStrictEqual} from 'node:util';
import type {TodayActionsV3Response,TodayTargetV3,TodayActionV3} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {readQualifiedResearchFirm} from '../sourcing/qualifiedResearch.ts';
import {readTodayActionsV2} from './actionsV2.ts';
/** V3 is additive. Research evidence is a review target, never outreach authority. */
export async function readTodayActionsV3(ctx:RepositoryContext,input:{now:string;includeFirmAssociations?:boolean}):Promise<TodayActionsV3Response|null>{
 const prior=await readTodayActionsV2(ctx,input);if(!prior)return null;
 const actions:TodayActionV3[]=[...prior.actions];
 const links=(await ctx.db.query<{firm_id:string}>('SELECT DISTINCT firm_id FROM sourcing_discovery_research_firms WHERE workspace_id=$1 ORDER BY firm_id',[ctx.scope.workspaceId])).rows;
 for(const link of links){const proof=await readQualifiedResearchFirm(ctx,link.firm_id);if(!proof)continue;
  actions.push({actionId:`qualified-research:${proof.firmId}`,kind:'research',subject:proof.firmName,reason:'qualified_research_ready',dueAt:proof.citations.map(c=>c.retrievedAt).sort()[0]!,state:'open',target:{kind:'qualified_research',...proof.selection,firmId:proof.firmId,promotionId:proof.promotionId,evidenceFingerprint:proof.evidenceFingerprint}});
 }
 if(!await activeIdentityActor(ctx))return null;
 return {...prior,version:3,actions};
}
export async function openTodayActionV3(ctx:RepositoryContext,input:{actionId:string;target:TodayTargetV3;now:string}){
 const projection=await readTodayActionsV3(ctx,{now:input.now});if(!projection)return null;
 const action=projection.actions.find(a=>a.actionId===input.actionId);
 const empty={version:3 as const,target:null,research:null};
 if(!action||!isDeepStrictEqual(action.target,input.target))return empty;
 if(action.target.kind!=='qualified_research')return {version:3 as const,target:action.target,research:null};
 const research=await readQualifiedResearchFirm(ctx,action.target.firmId);
 if(!research)return empty;
 const target={kind:'qualified_research' as const,...research.selection,firmId:research.firmId,promotionId:research.promotionId,evidenceFingerprint:research.evidenceFingerprint};
 return isDeepStrictEqual(target,input.target)&&await activeIdentityActor(ctx)?{version:3 as const,target,research}:empty;
}
