import {randomUUID} from 'node:crypto';
import {REQUIRED_SCHEMA} from '@fss/domain/db/schemaRange.ts';
import {createCrmCapabilityRuntime,type CrmCapabilityStartupConfiguration} from '@fss/domain/crm/capabilityStartup.ts';
import {CRM_SUPPORTED_AGENT_ASK_VERSIONS} from '@fss/domain/crm/capabilityAuthority.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {composeCrmCapabilities} from '../../../worker/src/bootstrap/crmCapabilities.ts';
import {registerHandlers} from '../../../worker/src/bootstrap/main.ts';
import {dispatch} from '../../src/server.ts';
import {CURRENT_CLIENT_VERSION,type AuthFixture} from './authFixture.ts';
import {issueSessionFor} from './sessionFixture.ts';

type AnswerRoute=NonNullable<CrmCapabilityStartupConfiguration['answer']>;
type AnswerModel=NonNullable<Parameters<typeof composeCrmCapabilities>[0]['answerModel']>;

/** Ordinary configured owner journey, not a direct-purpose controlled fixture.
 * This helper never activates a purpose: consent stays explicit in each scenario.
 * Model outputs remain controlled; configuration proves no hosted quality.
 */
export async function configuredAskFixture(fixture:AuthFixture,route:AnswerRoute){
 const db=await fixture.database.appRuntimeSession();
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
 const configuration:CrmCapabilityStartupConfiguration={capture:false,answer:route};
 const runtime=createCrmCapabilityRuntime(configuration,{implementationCommit:null,imageDigest:null,side:'api',schemaVersion:REQUIRED_SCHEMA,gmailAvailable:false});
 const post=(path:string,body:unknown,bearer=token)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${bearer}`}},{session:db,auth:{...fixture.deps,db},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmCapabilityRuntime:runtime});
 const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 return {db,post,command,
  saveDisabledPurpose:(evaluationFingerprint:string)=>post('/ask/purpose/save',command({expectedRevision:0,purpose:'answer',enabled:false,endpointId:route.endpointId,modelVersion:route.modelVersion,accessGrantVersion:route.accessGrantVersion,dataHandlingVersion:route.dataHandlingVersion,evaluationFingerprint,...CRM_SUPPORTED_AGENT_ASK_VERSIONS,agentLimits:route.agentLimits,dailyCeilingCents:100,monthlyCeilingCents:100,inputTokenPriceMicros:'1.1',outputTokenPriceMicros:'5.5'})),
  async composeWorker(answerModel:AnswerModel){
   const composed=await composeCrmCapabilities({configuration,runtime:{...runtime,side:'worker'},openSession:async()=>({session:await fixture.database.appRuntimeSession(),close:async()=>{}}),answerModel,loadSurface:async()=>({endpointId:route.endpointId,converse:async()=>{throw new Error('Converse must not bypass AI SDK agent');}})});
   return registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composed.handlers});
  },
 };
}
