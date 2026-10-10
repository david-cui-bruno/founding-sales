import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {experimentsReadSchema,experimentSaveCommandSchema,experimentActivateCommandSchema,experimentStopCommandSchema,experimentEraseCommandSchema} from '@fss/contracts';
import {readExperiments,saveExperiment,activateExperiment,stopExperiment,eraseExperiment} from '@fss/domain/sourcing/experiments.ts';
import {candidateCorrectNameCommandSchema} from '@fss/contracts';
import {correctCandidateName} from '@fss/domain/sourcing/candidateCorrection.ts';
import {firmQualificationReadSchema} from '@fss/contracts';
import {readFirmQualification} from '@fss/domain/sourcing/qualificationStore.ts';
import {sourcingFeedbackCommandSchema} from '@fss/contracts';
import {recordSourcingFeedback} from '@fss/domain/sourcing/feedback.ts';
import {qualificationReadSchema,qualificationRequestCommandSchema,qualificationAdmissionCommandSchema} from '@fss/contracts';
import {requestQualification,readQualification} from '@fss/domain/sourcing/qualificationStore.ts';
import {admitCandidate} from '@fss/domain/sourcing/admission.ts';
import {requestSourceCheck} from '@fss/domain/sourcing/sourceCheck.ts';
import {candidateCheckCommandSchema,candidateListInputSchema,candidateSaveCommandSchema,candidateReviewCommandSchema,candidateDeleteCommandSchema} from '@fss/contracts';
import {saveCandidate,listCandidates,reviewCandidate,deleteCandidate} from '@fss/domain/sourcing/candidates.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const SOURCING_PATHS=['/sourcing/experiments','/sourcing/experiments/save','/sourcing/experiments/activate','/sourcing/experiments/stop','/sourcing/experiments/erase','/sourcing/candidates/correct-name','/sourcing/qualification/firm','/sourcing/qualification/feedback','/sourcing/qualification/read','/sourcing/qualification/request','/sourcing/qualification/admit','/sourcing/candidates/check','/sourcing/candidates/list','/sourcing/candidates/save','/sourcing/candidates/review','/sourcing/candidates/delete'] as const;
export async function routeSourcing(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null> {
  if(!(SOURCING_PATHS as readonly string[]).includes(request.path))return null;
  if(!options.auth)return {status:404,body:{error:'not_found'}};
  if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
  const auth=options.auth,authenticated=await requirePrincipal(auth,request);
  if(!authenticated.ok)return authenticated.result;
  const deps={auth,request,principal:authenticated.principal};
  if(request.path==='/sourcing/experiments'){
    if(!experimentsReadSchema.safeParse(request.body).success)return {status:400,body:{error:'malformed_body'}};
    const scoped=contextForPrincipal(auth,authenticated.principal);if(!scoped.ok)return scoped.result;
    if(scoped.context.scope.actor.kind!=='user'||scoped.context.scope.actor.role!=='admin')return {status:403,body:{error:'admin_only'}};
    return {status:200,body:await withTransaction(auth.session,tx=>readExperiments(repositoryContext(scoped.context.scope,tx)))};
  }
  if(request.path==='/sourcing/experiments/save')return runRouteCommand(deps,experimentSaveCommandSchema,'sourcing.experiment_save',(c,body)=>{const {commandId:_id,clientVersion:_client,...input}=body;return saveExperiment(c,input);});
  if(request.path==='/sourcing/experiments/activate')return runRouteCommand(deps,experimentActivateCommandSchema,'sourcing.experiment_activate',(c,body)=>{const {commandId:_id,clientVersion:_client,...input}=body;return activateExperiment(c,input);});
  if(request.path==='/sourcing/experiments/stop')return runRouteCommand(deps,experimentStopCommandSchema,'sourcing.experiment_stop',(c,body)=>{const {commandId:_id,clientVersion:_client,...input}=body;return stopExperiment(c,input);});
  if(request.path==='/sourcing/experiments/erase')return runRouteCommand(deps,experimentEraseCommandSchema,'sourcing.experiment_erase',(c,body)=>{const {commandId:_id,clientVersion:_client,...input}=body;return eraseExperiment(c,input);});
  if(request.path==='/sourcing/qualification/feedback')return await runRouteCommand(deps,sourcingFeedbackCommandSchema,'sourcing.feedback',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;return recordSourcingFeedback(context,input);
  });
  if(request.path==='/sourcing/qualification/firm'){
    const parsed=firmQualificationReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
    const scoped=contextForPrincipal(auth,authenticated.principal);if(!scoped.ok)return scoped.result;
    const view=await readFirmQualification(scoped.context,parsed.data.firmId);return view?{status:200,body:view}:{status:404,body:{error:'not_found'}};
  }
  if(request.path==='/sourcing/qualification/read'){
    const parsed=qualificationReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
    const scoped=contextForPrincipal(auth,authenticated.principal);if(!scoped.ok)return scoped.result;
    const view=await readQualification(scoped.context,parsed.data);return view?{status:200,body:view}:{status:404,body:{error:'not_found'}};
  }
  if(request.path==='/sourcing/qualification/request')return await runRouteCommand(deps,qualificationRequestCommandSchema,'sourcing.qualify',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;return requestQualification(context,input);
  });
  if(request.path==='/sourcing/qualification/admit')return await runRouteCommand(deps,qualificationAdmissionCommandSchema,'sourcing.admit',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;return admitCandidate(context,input);
  });
  if(request.path==='/sourcing/candidates/check')return await runRouteCommand(deps,candidateCheckCommandSchema,'sourcing.check',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;
    return await requestSourceCheck(context,input);
  });
  if(request.path==='/sourcing/candidates/correct-name')return await runRouteCommand(deps,candidateCorrectNameCommandSchema,'sourcing.correct_name',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;
    return await correctCandidateName(context,input);
  });
  if(request.path==='/sourcing/candidates/save')return await runRouteCommand(deps,candidateSaveCommandSchema,'sourcing.save',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;
    return await saveCandidate(context,input);
  });
  if(request.path==='/sourcing/candidates/review')return await runRouteCommand(deps,candidateReviewCommandSchema,'sourcing.review',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;
    return await reviewCandidate(context,input);
  });
  if(request.path==='/sourcing/candidates/delete')return await runRouteCommand(deps,candidateDeleteCommandSchema,'sourcing.delete',async(context,body)=>{
    const {commandId:_commandId,clientVersion:_clientVersion,...input}=body;
    return await deleteCandidate(context,input);
  });
  const parsed=candidateListInputSchema.safeParse(request.body);
  if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  const scoped=contextForPrincipal(auth,authenticated.principal);
  if(!scoped.ok)return scoped.result;
  const answer=await listCandidates(scoped.context,parsed.data);
  return answer.ok?{status:200,body:answer.value}:{status:answer.reason==='admin_only'?403:400,body:{error:answer.reason}};
}
