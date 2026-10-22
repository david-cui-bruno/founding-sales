import {isDeepStrictEqual} from 'node:util';
import type {TodayActionsV4Response,TodayActionV4,TodayTargetV4} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {readAutomaticResearchFirm} from '../sourcing/automaticResearch.ts';
import {automaticResearchNow} from '../sourcing/automaticResearchAuthority.ts';
import {readTodayActionsV3,openTodayActionV3} from './actionsV3.ts';
/** Additive current-proof projection. Reads never publish or enqueue anything. */
export async function readTodayActionsV4(ctx:RepositoryContext,input:{now:string;includeFirmAssociations?:boolean}):Promise<TodayActionsV4Response|null>{
 const prior=await readTodayActionsV3(ctx,input);if(!prior)return null;
 const actions:TodayActionV4[]=[...prior.actions];
 const rows=(await ctx.db.query<{id:string}>('SELECT id FROM sourcing_automatic_research_firms WHERE workspace_id=$1 ORDER BY id',[ctx.scope.workspaceId])).rows;
 for(const row of rows){const proof=await readAutomaticResearchFirm(ctx,row.id);if(!proof)continue;
  actions.push({actionId:`automatic-research:${row.id}`,kind:'research',subject:proof.firmName,reason:'automatic_research_ready',dueAt:proof.citations.map(c=>c.retrievedAt).sort()[0]!,state:'open',target:proof.target});
 }
 if(!await activeIdentityActor(ctx))return null;
 // A later action read may have waited. Do not retain earlier expired evidence.
 const current:TodayActionV4[]=[];
 const expirations=new Map<string,string>();
 for(const action of actions){if(action.target.kind!=='automatic_research'){current.push(action);continue;}
  const proof=await readAutomaticResearchFirm(ctx,action.target.publicationId);
  if(proof&&isDeepStrictEqual(proof.target,action.target)){current.push(action);expirations.set(action.actionId,proof.validUntil);}
 }
 if(!await activeIdentityActor(ctx))return null;
 const now=await automaticResearchNow(ctx);
 return {...prior,version:4,actions:current.filter(action=>!expirations.has(action.actionId)||Date.parse(now)<Date.parse(expirations.get(action.actionId)!))};
}
export async function openTodayActionV4(ctx:RepositoryContext,input:{actionId:string;target:TodayTargetV4;now:string}){
 const empty={version:4 as const,target:null,research:null,automaticResearch:null};
 if(input.target.kind!=='automatic_research'){
  const prior=await openTodayActionV3(ctx,{...input,target:input.target});
  return prior?{...prior,version:4 as const,automaticResearch:null}:null;
 }
 if(input.actionId!==`automatic-research:${input.target.publicationId}`)return empty;
 const proof=await readAutomaticResearchFirm(ctx,input.target.publicationId);
 if(!proof||!isDeepStrictEqual(proof.target,input.target)||!await activeIdentityActor(ctx))return empty;
 return Date.parse(await automaticResearchNow(ctx))<Date.parse(proof.validUntil)?{version:4 as const,target:proof.target,research:null,automaticResearch:proof}:empty;
}
