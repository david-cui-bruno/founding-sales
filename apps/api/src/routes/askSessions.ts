import {projectAskAnswerForClient} from '@fss/domain/crm/askAnswers.ts';
import {askSessionCreateSchema,askSessionChangeSchema,askSessionTurnSchema,askSessionReadSchema,askSessionListSchema} from '@fss/contracts';
import {createAskSession,changeAskSession,requestAskSessionTurn,readAskSession,listAskSessions} from '@fss/domain/crm/askSessions.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const ASK_SESSION_PATHS=['/ask/sessions/create','/ask/sessions/change','/ask/sessions/turn','/ask/sessions/read','/ask/sessions/list'] as const;
export async function routeAskSessions(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(ASK_SESSION_PATHS as readonly string[]).includes(request.path))return null;
 if(options.auth===undefined)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 const deps={auth:options.auth,request,principal:verified.principal};
 if(request.path==='/ask/sessions/create')return runRouteCommand(deps,askSessionCreateSchema,'crm.ask_session_created',createAskSession);
 if(request.path==='/ask/sessions/change')return runRouteCommand(deps,askSessionChangeSchema,'crm.ask_session_changed',changeAskSession);
 if(request.path==='/ask/sessions/turn')return runRouteCommand(deps,askSessionTurnSchema,'crm.ask_session_turn_requested',requestAskSessionTurn);
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 if(request.path==='/ask/sessions/read'){
  const parsed=askSessionReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
  const result=await withTransaction(options.auth.db,()=>readAskSession(scoped.context,parsed.data.sessionId));return result===null?{status:404,body:redactError('not_found')}:{status:200,body:{...result,turns:result.turns.map(turn=>projectAskAnswerForClient(turn,parsed.data.includeExactResultCitations===true))}};
 }
 const parsed=askSessionListSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
 const result=await withTransaction(options.auth.db,()=>listAskSessions(scoped.context,parsed.data));return result===null?{status:404,body:redactError('not_found')}:{status:200,body:{...result,sessions:result.sessions.map(session=>({...session,turns:session.turns.map(turn=>projectAskAnswerForClient(turn,parsed.data.includeExactResultCitations===true))}))}};
}
