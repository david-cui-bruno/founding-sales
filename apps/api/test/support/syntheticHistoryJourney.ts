import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {askAnswerReadResultSchema,askHistoryPageSchema,askSessionViewSchema,selectedImportPageSchema,selectedImportPreviewSchema,selectedImportResultSchema,type AskAnswerReadResult} from '@fss/contracts';
import type {AuthFixture} from './authFixture.ts';
import type {EvaluationFixturePost} from './askEvaluationFixture.ts';
import {seedFirm} from './crmSeed.ts';

export const SYNTHETIC_HISTORY_QUESTION_IDS=['history_01','history_02','history_03','continuity_01','continuity_02'] as const;
export const SYNTHETIC_HISTORY_UNKNOWN_ACCEPTANCE='synthetic_history_unknown_acceptance_stopped';
const labels={expected:z.array(z.string().min(1)).min(1),forbidden:z.array(z.string().min(1)).min(1)};
const original=z.strictObject({slot:z.string().min(1),firm:z.enum(['primary','distractor']),text:z.string().min(1),occurredAt:z.null()});
const history=z.strictObject({id:z.string(),kind:z.literal('history'),category:z.enum(['separate_correction','conditional_offer','pilot_ambiguity']),firmName:z.string().min(1),question:z.string().min(1).max(300),originals:z.array(original).min(1).max(3),opportunities:z.array(z.strictObject({name:z.string().min(1),stage:z.enum(['new','qualified'])})).max(2),...labels});
const turn=z.strictObject({id:z.string(),question:z.string().min(1).max(300),...labels});
const session=z.strictObject({id:z.literal('continuity'),kind:z.literal('session'),firmName:z.string().min(1),opportunity:z.strictObject({name:z.string().min(1),stage:z.literal('new'),changedStage:z.literal('qualified')}),turns:z.tuple([turn.extend({id:z.literal('continuity_01')}),turn.extend({id:z.literal('continuity_02')})])});
const fixtureSchema=z.strictObject({version:z.literal('ask-history-continuity-v1'),cases:z.tuple([
 history.extend({id:z.literal('history_01'),category:z.literal('separate_correction')}),
 history.extend({id:z.literal('history_02'),category:z.literal('conditional_offer')}),
 history.extend({id:z.literal('history_03'),category:z.literal('pilot_ambiguity')}),
 session,
])});
export type SyntheticHistoryFixtures=z.infer<typeof fixtureSchema>;
export type SyntheticHistoryFixtureCase=SyntheticHistoryFixtures['cases'][number];
export function parseSyntheticHistoryFixtures(bytes:string|Uint8Array){return fixtureSchema.parse(JSON.parse(typeof bytes==='string'?bytes:new TextDecoder().decode(bytes)));}
export function flattenSyntheticHistoryTurns(fixtures:SyntheticHistoryFixtures){return fixtures.cases.flatMap<z.infer<typeof turn>>(item=>item.kind==='session'?item.turns:[{id:item.id,question:item.question,expected:item.expected,forbidden:item.forbidden}]);}

type Command=(body:object)=>object;
type CleanupSource={sourceId:string;firmId:string;slot:string;revision:number;metadataRevision:number};
type Capture={id:string;phase:'setup'|'answer'|'stage-change'|'source-cleanup'|'cleanup';record:unknown};
export type SyntheticHistoryJourneyCapture=Capture;
const opportunityReceipt=z.object({result:z.object({opportunityId:z.uuid()})});
const requestReceipt=z.object({result:z.object({requestId:z.uuid()})});
const sessionReceipt=z.object({result:z.object({sessionId:z.uuid(),version:z.number().int().positive()})});
async function checked(post:EvaluationFixturePost,path:string,body:unknown){const response=await post(path,body);if(response.status!==200)throw new Error(`synthetic_history_command_failed:${path}:${response.status}`);return response.body;}

/** Public disposable journey. Expected/forbidden labels are capture-only; no
 * labels, graders, seeded source IDs or original excerpts enter an Ask request.
 * Caller owns configured worker, provider budget and immutable capture storage.
 */
export async function runSyntheticHistoryJourney(input:{fixture:AuthFixture;post:EvaluationFixturePost;command:Command;item:SyntheticHistoryFixtureCase;execute:(requestId:string)=>Promise<void>;capture:(capture:Capture)=>Promise<void>|void}){
 const {fixture,post,command,item,execute,capture}=input;
 const firmId=await seedFirm(fixture,{name:item.firmName,assignedUserId:fixture.alpha.admin.userId});
 const cleanupSources:CleanupSource[]=[];
 const setupOriginals:{slot:string;sourceId:string;firmId:string;text:string}[]=[];
 const opportunityIds:string[]=[];
 const answers:{id:string;requestId:string;answer:AskAnswerReadResult}[]=[];
 let sessionId:string|undefined;
 let providerUnknown=false;
 let journeyResult:{firmId:string;sessionId:string|null;answers:typeof answers}|undefined;
 let journeyError:unknown;
 async function openOpportunity(name:string,stageKey:'new'|'qualified'){
  const receipt=opportunityReceipt.parse(await checked(post,'/opportunities/v2/open',command({firmId,name,stageKey})));
  opportunityIds.push(receipt.result.opportunityId);return receipt.result.opportunityId;
 }
 async function addNote(note:z.infer<typeof original>,targetFirmId:string){
  const selection={text:note.text,subtype:'pasted_text',label:'Synthetic retained business note',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=selectedImportPreviewSchema.parse(await checked(post,'/crm/imports/preview',selection));
  const added=selectedImportResultSchema.parse(z.object({result:selectedImportResultSchema}).parse(await checked(post,'/crm/imports/commit',command({...selection,personId:null,firmId:targetFirmId,importKey:randomUUID(),previewHash:preview.previewHash,parserVersion:'selected-v1'}))).result);
  const page=selectedImportPageSchema.parse(await checked(post,'/crm/imports/read',{firmId:targetFirmId,limit:100}));
  const read=page.imports.find(copy=>copy.source.sourceId===added.sourceId);
  if(!read)throw new Error('synthetic_history_import_readback_missing');
  cleanupSources.push({sourceId:added.sourceId,firmId:targetFirmId,slot:note.slot,revision:read.source.revision,metadataRevision:read.metadata.revision});
  setupOriginals.push({slot:note.slot,sourceId:added.sourceId,firmId:targetFirmId,text:note.text});
 }
 async function observe(id:string,requestId:string,question:string,expected:readonly string[],forbidden:readonly string[]){
  await execute(requestId);
  const answer=askAnswerReadResultSchema.parse(await checked(post,'/ask/answers/read',{requestId,includeExactResultCitations:true}));
  answers.push({id,requestId,answer});
  const diagnostics=await checked(post,'/ask/answers/diagnostics',{requestId});
  const navigation=[];
  for(const windowId of new Set(answer.answer?.claims.flatMap(claim=>claim.citationWindowIds)??[])){
   const read=await post('/ask/answers/source/read',{requestId,expectedVersion:answer.version,windowId});
   navigation.push({windowId,status:read.status,body:read.body});
  }
  const history=await checked(post,'/ask/history/list',{});
  const sessionRead=sessionId===undefined?null:await checked(post,'/ask/sessions/read',{sessionId,includeExactResultCitations:true});
  await capture({id,phase:'answer',record:{question,expected,forbidden,requestId,answer,diagnostics,navigation,history,session:sessionRead}});
  // Preserve the original unknown result before cleanup; never start a later
  // turn/scenario after ambiguous provider acceptance.
  if(answer.state==='unknown_acceptance'){providerUnknown=true;throw new Error(SYNTHETIC_HISTORY_UNKNOWN_ACCEPTANCE);}
  return answer;
 }
 try{
  if(item.kind==='history'){
   let distractorFirmId:string|undefined;
   for(const note of item.originals){
    if(note.firm==='distractor'&&distractorFirmId===undefined)distractorFirmId=await seedFirm(fixture,{name:'Other Harbor Example',assignedUserId:fixture.alpha.admin.userId});
    await addNote(note,note.firm==='primary'?firmId:distractorFirmId!);
   }
   for(const opportunity of item.opportunities)await openOpportunity(opportunity.name,opportunity.stage);
   const exactSetup=await checked(post,'/ask/read',{operation:'opportunities',scope:{firmId},status:'all',limit:20});
   await capture({id:item.id,phase:'setup',record:{firmId,originals:setupOriginals,opportunityIds,exactSetup}});
   const request=requestReceipt.parse(await checked(post,'/ask/answers/request',command({question:item.question,execution:'agent_v1',agentScope:{kind:'firm',firmId},scope:{sources:[]}})));
   await observe(item.id,request.result.requestId,item.question,item.expected,item.forbidden);
  }else{
   const opportunityId=await openOpportunity(item.opportunity.name,item.opportunity.stage);
   const created=sessionReceipt.parse(await checked(post,'/ask/sessions/create',command({scope:{kind:'firm',firmId}})));
   sessionId=created.result.sessionId;
   await capture({id:item.id,phase:'setup',record:{firmId,opportunityId,sessionId,exactSetup:await checked(post,'/ask/read',{operation:'opportunities',scope:{firmId},status:'all',limit:20})}});
   const first=item.turns[0];
   const requested=requestReceipt.parse(await checked(post,'/ask/sessions/turn',command({sessionId,version:created.result.version,question:first.question})));
   await observe(first.id,requested.result.requestId,first.question,first.expected,first.forbidden);
   const changed=await checked(post,'/opportunities/stage',command({opportunityId,expectedStageKey:item.opportunity.stage,toStageKey:item.opportunity.changedStage,reason:'Synthetic explicit human stage change'}));
   await capture({id:item.id,phase:'stage-change',record:{changed,exactRead:await checked(post,'/ask/read',{operation:'opportunities',scope:{firmId},status:'all',limit:20}),session:await checked(post,'/ask/sessions/read',{sessionId,includeExactResultCitations:true})}});
   const current=askSessionViewSchema.parse(await checked(post,'/ask/sessions/read',{sessionId,includeExactResultCitations:true}));
   const follow=item.turns[1];
   const followRequest=requestReceipt.parse(await checked(post,'/ask/sessions/turn',command({sessionId,version:current.version,question:follow.question})));
   await observe(follow.id,followRequest.result.requestId,follow.question,follow.expected,follow.forbidden);
  }
  journeyResult={firmId,sessionId:sessionId??null,answers};
 }catch(error){journeyError=error;}
 try{await cleanup();}catch(error){if(journeyError===undefined)journeyError=error;}
 if(journeyError!==undefined)throw journeyError;
 if(journeyResult===undefined)throw new Error('synthetic_history_result_missing');
 return journeyResult;
 async function cleanup(){
  // Source invalidation is captured before explicit investigation deletion, so
  // cleanup cannot conceal a broken original-dependency contract.
  try{
   const failures:string[]=[];
   const sourceDeletions=[];
   for(const source of cleanupSources){
    const response=await post('/crm/imports/delete',command({sourceId:source.sourceId,expectedSourceRevision:source.revision,expectedMetadataRevision:source.metadataRevision}));
    sourceDeletions.push({sourceId:source.sourceId,response});
    if(response.status!==200)failures.push('source_delete_failed');
   }
   const sourceAnswers=[];
   for(const originalAnswer of answers){
    const response=await post('/ask/answers/read',{requestId:originalAnswer.requestId,includeExactResultCitations:true});
    sourceAnswers.push({id:originalAnswer.id,response});
    const hadOriginals=(originalAnswer.answer.answer?.claims.some(claim=>claim.citationWindowIds.length>0)??false)||
     (originalAnswer.answer.fallback!==null&&'sources' in originalAnswer.answer.fallback.scope&&originalAnswer.answer.fallback.scope.sources.length>0);
    const read=askAnswerReadResultSchema.safeParse(response.body);
    if(cleanupSources.length>0&&hadOriginals&&(!read.success||read.data.question!==null||read.data.answer!==null||read.data.fallback!==null))failures.push('source_dependent_private_content_retained');
   }
   await capture({id:item.id,phase:'source-cleanup',record:{sourceDeletions,answers:sourceAnswers,history:await post('/ask/history/list',{})}});
   const sessionBeforeResponse=sessionId===undefined?null:await post('/ask/sessions/read',{sessionId,includeExactResultCitations:true});
   const parsedSession=sessionBeforeResponse?.status===200?askSessionViewSchema.safeParse(sessionBeforeResponse.body):null;
   const sessionBefore=parsedSession?.success?parsedSession.data:null;
   if(sessionId!==undefined&&sessionBefore===null)failures.push('session_cleanup_read_failed');
   const sessionDeletion=sessionBefore===null?null:await post('/ask/sessions/change',command({sessionId:sessionBefore.sessionId,version:sessionBefore.version,action:{kind:'delete'}}));
   if(sessionDeletion!==null&&sessionDeletion.status!==200)failures.push('session_delete_failed');
   const historyDeletions=[];
   if(sessionId===undefined){
    const before=await post('/ask/history/list',{});
    const page=before.status===200?askHistoryPageSchema.safeParse(before.body):null;
    if(!page?.success)failures.push('history_cleanup_read_failed');
    for(const answer of answers){
     const current=page?.success?page.data.items.find(record=>record.requestId===answer.requestId):undefined;
     if(current){
      const response=await post('/ask/history/change',command({requestId:answer.requestId,expectedRevision:current.historyRevision,action:{kind:'delete'}}));
      historyDeletions.push({requestId:answer.requestId,response});
      if(response.status!==200)failures.push('history_delete_failed');
     }
    }
   }
   const currentAnswers=[];
   for(const answer of answers){
    const response=await post('/ask/answers/read',{requestId:answer.requestId,includeExactResultCitations:true});
    currentAnswers.push({id:answer.id,response});
    const read=askAnswerReadResultSchema.safeParse(response.body);
    if(response.status!==200||!read.success||read.data.question!==null||read.data.answer!==null||read.data.fallback!==null)failures.push('final_private_content_retained');
   }
   const sessionAfter=sessionId===undefined?null:await post('/ask/sessions/read',{sessionId,includeExactResultCitations:true});
   if(sessionAfter!==null){
    const read=askSessionViewSchema.safeParse(sessionAfter.body);
    if(sessionAfter.status!==200||!read.success||read.data.state!=='deleted'||read.data.title!==null||read.data.scope!==null||read.data.turns.length!==0)failures.push('session_private_content_retained');
   }
   const history=await post('/ask/history/list',{});
   const page=askHistoryPageSchema.safeParse(history.body);
   if(history.status!==200||!page.success||page.data.items.some(record=>answers.some(answer=>answer.requestId===record.requestId)))failures.push('final_history_retained');
   await capture({id:item.id,phase:'cleanup',record:{sourceDeletions,sessionBefore,sessionDeletion,historyDeletions,answers:currentAnswers,sessionAfter,history,failures}});
   if(failures.length>0)throw new Error(`synthetic_history_cleanup_failed:${failures.join(',')}`);
  }catch(error){
   // Cleanup artifacts preserve any observed failures. Ambiguous provider
   // acceptance remains the original stopping reason and never authorizes retry.
   if(!providerUnknown)throw error;
  }
 }
}
