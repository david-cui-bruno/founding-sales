import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {selectedImportPageSchema,selectedImportPreviewSchema,selectedImportResultSchema,type AskAgentScope} from '@fss/contracts';
import type {EvaluationFixturePost} from './askEvaluationFixture.ts';
const opportunity=z.strictObject({name:z.string().min(1),status:z.enum(['open','lost']).optional(),stage:z.enum(['new','qualified','lost']).optional()});
const task=z.strictObject({label:z.string().min(1),status:z.enum(['open','done']),due:z.iso.date().nullable(),zone:z.literal('America/New_York').optional()}).refine(t=>t.due===null||t.zone!==undefined);
const caseSchema=z.strictObject({id:z.string(),firmName:z.string().min(1),category:z.enum(['exact_only','reported_certainty','pilot_ambiguity','conditional_offer','retraction']),question:z.string().min(1),initialScope:z.enum(['firm_no_sources','selected']),seeds:z.strictObject({opportunities:z.array(opportunity).optional(),tasks:z.array(task).optional()}).optional(),originals:z.array(z.strictObject({kind:z.literal('selected_note'),text:z.string().min(1),occurredAt:z.null()})),expected:z.array(z.string()).min(1),forbidden:z.array(z.string()).min(1),agentScopeDates:z.strictObject({to:z.literal('2026-10-07T04:00:00Z'),basis:z.string()}).optional()}).refine(c=>c.initialScope==='selected'?c.originals.length===1:c.originals.length===0);
const fixtureSchema=z.strictObject({version:z.literal('ask-contract-fixtures-v4'),cases:z.array(caseSchema).length(8)}).refine(f=>f.cases.every((c,i)=>c.id===`crm2_${String(i+1).padStart(2,'0')}`));
export type SyntheticAskFixtureCase=z.infer<typeof caseSchema>;
export function parseSyntheticAskFixtures(bytes:string|Uint8Array){return fixtureSchema.parse(JSON.parse(typeof bytes==='string'?bytes:new TextDecoder().decode(bytes)));}
type SourceRef={workspaceId:string;sourceId:string;kind:'selected_note';revision:number;contentHash:string;locator:null};
type Command=(body:object)=>object;
const idResult=z.object({result:z.object({opportunityId:z.uuid()})});
const actionResult=z.object({result:z.object({actionId:z.uuid(),version:z.number().int().positive()})});
async function checked(post:EvaluationFixturePost,path:string,body:unknown){const response=await post(path,body);if(response.status!==200)throw new Error(`synthetic_fixture_setup_failed:${path}:${response.status}`);return response.body;}
/** Public disposable setup only. Labels remain separate from every model-facing scope. */
export async function prepareSyntheticAskFixture(post:EvaluationFixturePost,command:Command,context:{workspaceId:string;firmId:string},fixtureCase:SyntheticAskFixtureCase){
 const {workspaceId,firmId}=context;
 const cleanupSources:(SourceRef&{metadataRevision:number})[]=[];
 const seedObservation:Record<string,unknown>={};
 const importNote=async(text:string,label:string)=>{
  const input={text,subtype:'pasted_text',label,direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=selectedImportPreviewSchema.parse(await checked(post,'/crm/imports/preview',input));
  const committed=selectedImportResultSchema.parse(z.object({result:selectedImportResultSchema}).parse(await checked(post,'/crm/imports/commit',command({...input,personId:null,firmId,importKey:randomUUID(),previewHash:preview.previewHash,parserVersion:'selected-v1'}))).result);
  const page=selectedImportPageSchema.parse(await checked(post,'/crm/imports/read',{firmId,limit:100}));
  const read=page.imports.find(i=>i.source.sourceId===committed.sourceId);
  if(!read||read.source.contentHash===null||read.source.kind!=='selected_note')throw new Error('synthetic_fixture_source_readback_failed');
  const ref:SourceRef={workspaceId,sourceId:read.source.sourceId,kind:'selected_note',revision:read.source.revision,contentHash:read.source.contentHash,locator:null};
  cleanupSources.push({...ref,metadataRevision:read.metadata.revision});
  return ref;
 };
 for(const seed of fixtureCase.seeds?.opportunities??[]){
  const stageKey=seed.stage==='qualified'?'qualified':'new';
  const opened=idResult.parse(await checked(post,'/opportunities/v2/open',command({firmId,name:seed.name,stageKey})));
  if(seed.status==='lost'||seed.stage==='lost')await checked(post,'/opportunities/stage',command({opportunityId:opened.result.opportunityId,expectedStageKey:stageKey,toStageKey:'lost',reason:'Synthetic closed comparison opportunity'}));
 }
 if(fixtureCase.seeds?.opportunities)seedObservation['opportunities']=await checked(post,'/ask/read',{operation:'opportunities',scope:{firmId},status:'all',limit:20});
 const tasks=fixtureCase.seeds?.tasks;
 if(tasks){
  const setupSource=await importNote('Birch setup tasks: check dimensions, prepare options, future check, completed check, undated check.','Synthetic task setup only');
  const setup=z.object({result:z.object({requestId:z.uuid()})}).parse(await checked(post,'/ask/answers/request',command({question:'Birch setup tasks',scope:{sources:[setupSource]}})));
  const setupRead=await checked(post,'/ask/answers/read',{requestId:setup.result.requestId});
  if(!z.object({state:z.literal('unavailable')}).safeParse(setupRead).success)throw new Error('synthetic_task_setup_requires_disabled_answering');
  seedObservation['setupRequest']=setupRead;
  for(const seed of tasks){
   const due=seed.due===null?null:{kind:'date',date:seed.due,zone:seed.zone,expression:seed.due};
   const created=actionResult.parse(await checked(post,'/ask/actions/create',command({requestId:setup.result.requestId,expectedVersion:1,finding:{kind:'keyword_passage',index:0},action:{kind:'task',label:seed.label,due,target:{kind:'firm',firmId}}})));
   if(seed.status==='done')await checked(post,'/ask/actions/change',command({actionId:created.result.actionId,expectedVersion:created.result.version,action:'complete_task'}));
  }
  seedObservation['tasks']=await checked(post,'/ask/read',{operation:'tasks',scope:{firmId,to:fixtureCase.agentScopeDates?.to},limit:20});
  seedObservation['taskActions']=await checked(post,'/ask/actions/read',{scope:{kind:'firm',firmId}});
 }
 const sources:SourceRef[]=[];
 for(const original of fixtureCase.originals)sources.push(await importNote(original.text,`Frozen ${fixtureCase.id}`));
 const agentScope:AskAgentScope=fixtureCase.initialScope==='selected'?{kind:'selected',sources}:{kind:'firm',firmId,...(fixtureCase.agentScopeDates?{to:fixtureCase.agentScopeDates.to}:{})};
 return {sources,cleanupSources,requestScope:{agentScope,scope:{sources}},seedObservation};
}
