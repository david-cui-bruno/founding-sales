import type {RepositoryContext} from '../db/workspaceScope.ts';
import {CallingPreparationChanged,requireCurrentCallingPreparation} from './preparation.ts';

/** Existing route refusal vocabulary; no new execution authority. Callers retain
 * upfront lifecycle custody, then their ordinary gate, through commit/publication.
 */
export async function readPreparationExecution(context:RepositoryContext,firmId:string):Promise<{ok:true;expiresAt:string|null}|{ok:false;reason:'route_invalid'}>{
 try{return {ok:true,expiresAt:await requireCurrentCallingPreparation(context,firmId)};}
 catch(error){if(error instanceof CallingPreparationChanged)return {ok:false,reason:'route_invalid'};throw error;}
}
