import {retainedIdentityDecisionCommandSchema,retainedInterpretationCommandSchema} from '@fss/contracts';
import {decideRetainedIdentity,interpretRetainedQualification} from '@fss/domain/sourcing/retainedRecovery.ts';
import {runRouteCommand,type RouteDeps} from './routeSupport.ts';
export const RETAINED_RECOVERY_PATHS=['/sourcing/qualification/recovery/identity','/sourcing/qualification/recovery/interpret'] as const;
export function routeRetainedRecovery(deps:RouteDeps){
 if(deps.request.path===RETAINED_RECOVERY_PATHS[0])return runRouteCommand(deps,retainedIdentityDecisionCommandSchema,'sourcing.retained_identity',async(ctx,body)=>{const {commandId:_id,clientVersion:_version,...input}=body;return decideRetainedIdentity(ctx,input);});
 return runRouteCommand(deps,retainedInterpretationCommandSchema,'sourcing.retained_interpretation',async(ctx,body)=>{const {commandId:_id,clientVersion:_version,...input}=body;return interpretRetainedQualification(ctx,input);});
}
