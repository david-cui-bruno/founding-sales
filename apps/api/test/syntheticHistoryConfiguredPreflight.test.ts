import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {configuredAskFixture} from './support/configuredAskFixture.ts';
import {parseSyntheticHistoryFixtures,runSyntheticHistoryJourney,SYNTHETIC_HISTORY_UNKNOWN_ACCEPTANCE,type SyntheticHistoryJourneyCapture} from './support/syntheticHistoryJourney.ts';

const fixtureCases=parseSyntheticHistoryFixtures(readFileSync(new URL('../../../tools/ask-evaluation/fixtures/ask-history-continuity-v1.json',import.meta.url)));
const windowSchema=z.object({windows:z.array(z.object({id:z.string(),text:z.string(),source:z.object({sourceId:z.uuid()})}))});

// Fake external SDK outputs prove host orchestration and lifecycle contracts.
// They do not score hosted model usefulness or representative customer quality.
async function preflight(itemIndex:0|1|2|3,unknownAcceptance=false,cleanupFailure=false){
 const fixture=await createAuthFixture();try{
  const item=fixtureCases.cases[itemIndex];
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6' as const,providerKey:'controlled.ask_sdk',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:6,maxInputBytes:30000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  expect((await saveDisabledPurpose('d'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-history-preflight-not-hosted-quality',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  let calls=0;let maxFramedBytes=0;let modelFailure:unknown;
  const captures:SyntheticHistoryJourneyCapture[]=[];
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   try{
    calls++;
    const framedBytes=Buffer.byteLength(JSON.stringify(input),'utf8')+2048;
    maxFramedBytes=Math.max(maxFramedBytes,framedBytes);
    expect(framedBytes).toBeLessThanOrEqual(30000);
    if(unknownAcceptance)throw new Error('controlled_transport_outcome_unknown');
    const prompt=JSON.stringify(input.prompt);
    const labels=item.kind==='history'?[...item.expected,...item.forbidden]:item.turns.flatMap(turn=>[...turn.expected,...turn.forbidden]);
    for(const label of labels)expect(prompt).not.toContain(label);
    const results=input.prompt.flatMap(message=>message.role==='tool'?message.content.flatMap(part=>part.type==='tool-result'&&part.output.type==='json'?[{name:part.toolName,value:part.output.value}]:[]):[]);
    const tool=(toolName:string,input:object)=>({type:'tool-call' as const,toolCallId:`history-preflight-${calls}`,toolName,input:JSON.stringify(input)});
    let response;
    if(item.kind==='session'){
     const user=input.prompt.find(message=>message.role==='user');
     if(!user)throw new Error('preflight_user_question_missing');
     const text=user.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('');
     const question=z.object({question:z.string()}).parse(JSON.parse(text)).question;
     const follow=question===item.turns[1].question;
     if(calls%2===1){
      if(follow){expect(prompt).toContain(item.turns[0].question);expect(prompt).not.toContain('The North pilot currently has the recorded stage new.');}
      response=tool('read_exact',{operation:'opportunities'});
     }else{
      const exact=JSON.stringify(results.find(result=>result.name==='read_exact')?.value);
      expect(exact).toContain(follow?'qualified':'new');
      response=tool('emit_answer',{claims:[{text:follow?'The North pilot currently has the recorded stage qualified.':'The North pilot currently has the recorded stage new.',kind:'fact',citationWindowIds:[],exactResultToolCallIds:['e1']}],abstained:false});
     }
    }else if(itemIndex===2){
     if(calls===1){response=tool('browse_history',{limit:5});}
     else if(calls===2){
      const browse=windowSchema.parse(results.at(-1)?.value);
      expect(browse.windows.map(window=>window.text)).toEqual([item.originals[0]!.text]);
      response=tool('read_exact',{operation:'opportunities'});
     }else{
      const browse=windowSchema.parse(results.find(result=>result.name==='browse_history')?.value);
      const exact=JSON.stringify(results.find(result=>result.name==='read_exact')?.value);
      expect(exact).toContain('East pilot');expect(exact).toContain('West pilot');expect(exact).toContain('qualified');
      response=tool('emit_answer',{claims:[{text:'The note requests a revised proposal but does not identify which pilot.',kind:'fact',citationWindowIds:[browse.windows[0]!.id],exactResultToolCallIds:[]},{text:'CRM records list East pilot at qualified and West pilot at new; those stages do not identify the requested pilot.',kind:'inference',citationWindowIds:[browse.windows[0]!.id],exactResultToolCallIds:['e1']}],abstained:false});
     }
    }else if(itemIndex===1){
     if(calls===1){expect(prompt).not.toContain(item.originals[0]!.text);response=tool('browse_history',{limit:5});}
     else if(calls===2){
      const browse=windowSchema.parse(results.at(-1)?.value);
      expect(browse.windows.map(window=>window.text)).toEqual(expect.arrayContaining(item.originals.filter(note=>note.firm==='primary').map(note=>note.text)));
      expect(prompt).not.toContain(item.originals.find(note=>note.firm==='distractor')!.text);
      const offer=browse.windows.find(window=>window.text===item.originals[0]!.text)!;
      response=tool('read_conversation',{sourceId:offer.source.sourceId,kind:'selected_note',limit:3});
     }else{
      const conversation=windowSchema.parse(results.at(-1)?.value);
      const offer=conversation.windows.find(window=>window.text===item.originals[0]!.text)!;
      response=tool('emit_answer',{claims:[{text:'The note offers a field mapping demonstration next week if a scrubbed sample is sent; import implementation has not been agreed.',kind:'fact',citationWindowIds:[offer.id],exactResultToolCallIds:[]}],abstained:false});
     }
    }else if(calls===1){expect(prompt).not.toContain(item.originals[0]!.text);response=tool('search_history',{query:'sample',limit:5});}
    else if(calls===2){
     const search=windowSchema.parse(results.find(result=>result.name==='search_history')?.value);
     expect(search.windows.map(window=>window.text)).toEqual([item.originals[0]!.text]);
     response=tool('browse_history',{limit:5});
    }else if(calls===3){
     const browse=windowSchema.parse(results.find(result=>result.name==='browse_history')?.value);
     const correction=browse.windows.find(window=>window.text===item.originals[1]!.text);expect(correction).toBeDefined();
     response=tool('read_conversation',{sourceId:correction!.source.sourceId,kind:'selected_note',limit:3});
    }else{
     const conversation=windowSchema.parse(results.at(-1)?.value);
     const correction=conversation.windows.find(window=>window.text===item.originals[1]!.text);expect(correction).toBeDefined();
     response=tool('emit_answer',{claims:[{text:'The later note cancels the Thursday plan and gives no agreed replacement date.',kind:'fact',citationWindowIds:[correction!.id],exactResultToolCallIds:[]}],abstained:false});
    }
    return {content:[response],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
   }catch(error){modelFailure=error;throw error;}
  }});
  const registry=await composeWorker(model);
  const journeyPost:typeof post=async(path,body)=>{
   const deletion=z.object({sourceId:z.uuid(),expectedSourceRevision:z.number(),expectedMetadataRevision:z.number(),commandId:z.uuid(),clientVersion:z.string()}).safeParse(body);
   // Inject a real stale public command rather than mocking domain deletion.
   if(cleanupFailure&&path==='/crm/imports/delete'&&deletion.success)return post(path,{...deletion.data,expectedMetadataRevision:999});
   return post(path,body);
  };
  const journey=runSyntheticHistoryJourney({fixture,post:journeyPost,command,item,execute:async()=>{expect((await runOnce(db,{registry,owner:'synthetic-history-preflight',limit:20})).failed).toBe(0);},capture:record=>{captures.push(record);}});
  if(unknownAcceptance){
   await expect(journey).rejects.toThrow(SYNTHETIC_HISTORY_UNKNOWN_ACCEPTANCE);
   expect(calls).toBe(1);
   expect(captures.filter(record=>record.phase==='answer')).toHaveLength(1);
   expect(captures.find(record=>record.phase==='answer')?.record).toMatchObject({answer:{state:'unknown_acceptance',reason:'provider_acceptance_unknown'}});
   expect(captures.some(record=>record.phase==='stage-change')).toBe(false);
   if(item.kind==='session')expect(captures.find(record=>record.phase==='cleanup')?.record).toMatchObject({sessionDeletion:{status:200},sessionAfter:{status:200,body:{state:'deleted',turns:[]}}});
   if(cleanupFailure)expect(captures.find(record=>record.phase==='cleanup')?.record).toMatchObject({failures:expect.arrayContaining(['source_delete_failed'])});
   return;
  }
  if(cleanupFailure){
   await expect(journey).rejects.toThrow('synthetic_history_cleanup_failed');
   expect(captures.find(record=>record.phase==='answer')?.record).toMatchObject({answer:{state:'complete'}});
   expect(captures.find(record=>record.phase==='source-cleanup')?.record).toMatchObject({sourceDeletions:expect.arrayContaining([{sourceId:expect.any(String),response:expect.objectContaining({status:409})}]),answers:[{response:{body:{state:'complete'}}}]});
   expect(captures.find(record=>record.phase==='cleanup')?.record).toMatchObject({failures:expect.arrayContaining(['source_delete_failed','source_dependent_private_content_retained']),answers:[{response:{body:{state:'deleted',question:null,answer:null,fallback:null}}}]});
   return;
  }
  await journey;
  expect(modelFailure).toBeUndefined();
  process.stdout.write(`Controlled ${item.id} preflight: ${calls} fake generations, max ${maxFramedBytes} framed UTF-8 bytes incl 2048 overhead; no provider dispatch.\n`);
  const answer=captures.find(record=>record.phase==='answer');
  if(item.kind==='history'){
   expect(answer?.record).toMatchObject({answer:{state:'complete'},navigation:[{status:200,body:{source:{passage:{text:item.originals[itemIndex===0?1:0]!.text}}}}]});
   const tools=itemIndex===0?['search_history','browse_history','read_conversation']:itemIndex===1?['browse_history','read_conversation']:['browse_history','read_exact'];
   expect(answer?.record).toMatchObject({diagnostics:{requestedToolNames:tools,executedToolNames:tools}});
   if(itemIndex===2)expect(answer?.record).toMatchObject({answer:{answer:{claims:[{exactResultToolCallIds:[]},{exactResultToolCallIds:['history-preflight-2']}]}}});
   expect(captures.find(record=>record.phase==='source-cleanup')?.record).toMatchObject({sourceDeletions:item.originals.map(()=>({response:{status:200}})),answers:[{response:{body:{state:'stale',question:null,answer:null,fallback:null}}}]});
   expect(captures.find(record=>record.phase==='cleanup')?.record).toMatchObject({answers:[{response:{body:{state:'deleted',question:null,answer:null,fallback:null}}}],failures:[]});
  }else{
   expect(captures.filter(record=>record.phase==='answer').map(record=>record.id)).toEqual(['continuity_01','continuity_02']);
   expect(captures.find(record=>record.id==='continuity_01'&&record.phase==='answer')?.record).toMatchObject({answer:{state:'complete',answer:{claims:[{text:'The North pilot currently has the recorded stage new.',citationWindowIds:[],exactResultToolCallIds:['history-preflight-1']}]}},navigation:[]});
   expect(captures.find(record=>record.id==='continuity_02'&&record.phase==='answer')?.record).toMatchObject({answer:{state:'complete',answer:{claims:[{text:'The North pilot currently has the recorded stage qualified.',citationWindowIds:[],exactResultToolCallIds:['history-preflight-3']}]}},diagnostics:{executedToolNames:['read_exact']},navigation:[]});
   expect(captures.find(record=>record.phase==='cleanup')?.record).toMatchObject({sourceDeletions:[],sessionBefore:{state:'active'},sessionDeletion:{status:200},answers:[{response:{body:{state:'deleted',question:null,answer:null,fallback:null}}},{response:{body:{state:'deleted',question:null,answer:null,fallback:null}}}],sessionAfter:{status:200,body:{state:'deleted',title:null,scope:null,turns:[]}}});
  }
 }finally{await fixture.stop();}
}
it('preflights separate-correction discovery and cleanup through the configured SDK worker',()=>preflight(0),90000);
it('preflights a scoped conditional offer while excluding another firm agreement',()=>preflight(1),90000);
it('preflights ambiguous pilot history with current exact state without turning stage into an association',()=>preflight(2),90000);
it('preflights fresh exact state after a human stage change and deletes the two-turn session',()=>preflight(3),90000);
it('retains the ambiguous first result and stops before the second turn while deleting the disposable session',()=>preflight(3,true),90000);
it('captures failed original deletion and fails acceptance even when explicit history deletion succeeds',()=>preflight(0,false,true),90000);
it('preserves the unknown provider stop when original cleanup also fails',()=>preflight(0,true,true),90000);
