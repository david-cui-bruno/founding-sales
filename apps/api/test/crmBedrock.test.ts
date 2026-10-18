import {crmProcessingResultSchema} from '@fss/contracts';
import capturedSonnet46 from './support/capturedSonnet46Extraction.json' with {type:'json'};
import capturedExtractionSources from './support/capturedExtractionSources.json' with {type:'json'};
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createBedrockCrmExtractionAdapter } from '../../worker/src/providers/crmBedrock.ts';
import { composeCrmBedrock } from '../../worker/src/bootstrap/crmBedrock.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

async function selectedOriginal(text = 'Maintenance routing requires a coordinator.') {
  const fixture = await createAuthFixture();
  try {
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const post = (path: string, body: unknown) => dispatch(
      { method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } },
      { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false },
    );
    const command = (fields: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
    const firmId = await seedFirm(fixture, { name: 'Controlled source safety firm', assignedUserId: fixture.alpha.salesperson.userId });
    const selection = { text, subtype: 'pasted_text', label: 'Controlled source content', direction: 'unknown', participants: [], occurredAt: null, attachments: [] };
    const preview = await post('/crm/imports/preview', selection);
    expect(preview.status).toBe(200);
    const imported = await post('/crm/imports/commit', command({ ...selection, personId: null, firmId, importKey: randomUUID(), previewHash: (preview.body as { previewHash: string }).previewHash, parserVersion: 'selected-v1' }));
    expect(imported.status).toBe(200);
    const sourceId = (imported.body as { result: { sourceId: string } }).result.sourceId;
    return { fixture, post, sourceId, firmId, text };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}

it('binds purpose-specific extraction into the normal registry and publishes exact quoted evidence', async () => {
  const selected = await selectedOriginal();
  try {
    const created = await selected.post('/crm/people/create', { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, fullName: 'Bedrock extraction fixture' });
    const personId = (created.body as { result: { personId: string } }).result.personId;
    const text = 'We need faster repairs.';
    expect((await selected.post('/crm/people/source/add', { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, personId, sourceKey: 'bedrock-extraction', excerpt: text, occurredAt: '2026-10-01T14:00:00Z' })).status).toBe(200);
    const page = await selected.post('/crm/people/read', { personId });
    const stored = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0]!;
    const source = { workspaceId: stored.workspaceId, sourceId: stored.sourceId, revision: stored.revision, contentHash: stored.contentHash, kind: 'selected_note', locator: null };
    await selected.fixture.db.query(`INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,1,true,'controlled-extraction','literal-v1','extraction-only-grant','fixture-no-retention',10,100,1,1,$2)`, [selected.fixture.alpha.workspaceId, selected.fixture.alpha.admin.userId]);
    expect((await selected.post('/crm/processing/request', { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, source })).status).toBe(200);
    let calls = 0;
    const composition = composeCrmBedrock({allowControlledEvaluation:true, surface: { async converse(input) {
      calls++;
      expect(input.modelId).toBe('literal-v1');
      expect(input.messages[0]!.content[0]!.text).toBe(text);
      expect(input.inferenceConfig.maxTokens).toBe(4096);
      expect(input).toMatchObject({additionalModelRequestFields:{thinking:{type:'disabled'}}});
      return { stopReason: 'tool_use', usage: { inputTokens: 20, outputTokens: 30 }, output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'controlled-extraction', name: 'emit_crm_extraction', input: { claims: [{ kind: 'need', interpretation: 'Faster repairs', status: 'stated', locator: 'text:0:23', quote: text }] } } }] } } };
    } }, extraction: { endpointId: 'controlled-extraction', modelVersion: 'literal-v1', accessGrantVersion: 'extraction-only-grant', dataHandlingVersion: 'fixture-no-retention', providerKey: 'fixture.crm_extraction', fundingVerifiedUntil: '2099-01-01T00:00:00Z' } });
    const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, ...composition });
    await runOnce(selected.fixture.db, { registry, owner: 'controlled-bedrock-extraction', limit: 20 });
    expect(calls).toBe(1);
    expect((await selected.post('/crm/processing/read', { source })).body).toMatchObject({ state: 'complete', claims: [{ kind: 'need', quote: text }], financial: { dispatchState: 'settled', settledCents: 1 } });
  } finally { await selected.fixture.stop(); }
});

const cacheUsageCases=[
 {label:'uncached',usage:{inputTokens:50,outputTokens:30},known:true,inputTotal:50},
 {label:'cache read',usage:{inputTokens:50,outputTokens:30,cacheReadInputTokens:20,cacheWriteInputTokens:0},known:true,inputTotal:70},
 {label:'cache write pricing unbound',usage:{inputTokens:50,outputTokens:30,cacheWriteInputTokens:20},known:false,inputTotal:null},
 {label:'fractional cache read',usage:{inputTokens:50,outputTokens:30,cacheReadInputTokens:1.5},known:false,inputTotal:null},
 {label:'negative cache read',usage:{inputTokens:50,outputTokens:30,cacheReadInputTokens:-1},known:false,inputTotal:null},
 {label:'cache total overflow',usage:{inputTokens:50,outputTokens:30,cacheReadInputTokens:Number.MAX_SAFE_INTEGER},known:false,inputTotal:null},
];
it.each(cacheUsageCases)('native extraction usage $label preserves original evidence and unknown holds', async example => {
  const selected = await selectedOriginal();
  try {
    const workspaceId = selected.fixture.alpha.workspaceId;
    const meetingId = randomUUID(), recordingId = randomUUID(), transcriptId = randomUUID();
    await selected.fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'bedrock-native','bedrock-native','booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())", [workspaceId, meetingId, selected.firmId]);
    await selected.fixture.db.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Synthetic native transcript',$4,100,$5,'ready')", [workspaceId, recordingId, meetingId, 'a'.repeat(64), `meetings/${meetingId}/${'a'.repeat(64)}.m4a`]);
    const quote = 'We need a repair coordinator.';
    const utterances = [{ startMs: 0, endMs: 5000, text: quote, speaker: 'Fixture speaker', attribution: 'source_label' }];
    await selected.fixture.db.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)", [workspaceId, transcriptId, recordingId, JSON.stringify(utterances)]);
    const source = { workspaceId, kind: 'meeting_transcript', sourceId: transcriptId, revision: 1, contentHash: createHash('sha256').update(JSON.stringify(utterances)).digest('hex'), locator: null };
    await selected.fixture.db.query(`INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,1,true,'controlled-extraction','literal-v1','extraction-only-grant','fixture-no-retention',10,100,1,1,$2)`, [workspaceId, selected.fixture.alpha.admin.userId]);
    expect((await selected.post('/crm/processing/request', { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, source })).status).toBe(200);
    const composition = composeCrmBedrock({allowControlledEvaluation:true, surface: { async converse(input) {
      expect(input.system[0]!.text).toContain('utterance:N:text:start:end');
      expect(input.system[0]!.text).toContain('not serialized JSON');
      expect(input.system[0]!.text).toContain('stated means a direct assertion');
      expect(input.system[0]!.text).toContain('Inferred needs must use status inferred');
      expect(input.system[0]!.text).toContain('Rejection or disagreement is an objection');
      expect(input.system[0]!.text).toContain('unless the source explicitly expresses it');
      expect(input.toolConfig?.tools[0]?.toolSpec.inputSchema.json).toMatchObject({properties:{claims:{items:{properties:{kind:{description:expect.stringContaining('not commitment even when status is inferred')},status:{description:expect.stringContaining('does not permit classifying an offer as commitment')}}}}}});
      expect(Buffer.byteLength(input.system[0]!.text)).toBeLessThanOrEqual(1024);
      expect(JSON.parse(input.messages[0]!.content[0]!.text)).toMatchObject([{ utterance: 0, speaker: 'Fixture speaker', text: quote, locator: 'utterance:0:text:0:29' }]);
      return { stopReason: 'tool_use', usage: example.usage, output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'controlled-transcript', name: 'emit_crm_extraction', input: { claims: [{ kind: 'need', interpretation: 'Repair coordinator', status: 'stated', locator: 'utterance:0:text:0:29', quote }] } } }] } } };
    } }, extraction: { endpointId: 'controlled-extraction', modelVersion: 'literal-v1', accessGrantVersion: 'extraction-only-grant', dataHandlingVersion: 'fixture-no-retention', providerKey: 'fixture.crm_extraction', fundingVerifiedUntil: '2099-01-01T00:00:00Z' } });
    const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, ...composition });
    await runOnce(selected.fixture.db, { registry, owner: 'controlled-bedrock-native-extraction', limit: 20 });
    expect((await selected.post('/crm/processing/read', { source })).body).toMatchObject(example.known?{ state: 'complete', claims: [{ kind: 'need', quote, source: { sourceId: transcriptId, kind: 'meeting_transcript', speaker: 'Fixture speaker', locator: 'utterance:0:text:0:29' } }],financial:{dispatchState:'settled'} }:{state:'unknown_acceptance',claims:[],financial:{dispatchState:'unknown_acceptance'}});
  } finally { await selected.fixture.stop(); }
});


it.each(capturedSonnet46.caseIds)('replays actual synthetic Sonnet4.6 native output through original-source processing: %s',async caseId=>{
 const label=capturedExtractionSources.find(item=>item.caseId===caseId)!;
 const response=capturedSonnet46.responses[capturedSonnet46.caseIds.indexOf(caseId)]!;
 const selected=await selectedOriginal(label.syntheticText);
 try{
  const modelVersion='us.anthropic.claude-sonnet-4-6';
  const source={workspaceId:selected.fixture.alpha.workspaceId,sourceId:selected.sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(label.syntheticText).digest('hex'),locator:null};
  await selected.fixture.db.query("INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,1,true,'controlled-extraction',$2,'extraction-only-grant','fixture-no-retention',100,1000,6,16.5,$3)",[selected.fixture.alpha.workspaceId,modelVersion,selected.fixture.alpha.admin.userId]);
  expect((await selected.post('/crm/processing/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,source})).status).toBe(200);
  let calls=0;
  const composition=composeCrmBedrock({allowControlledEvaluation:true,extraction:{endpointId:'controlled-extraction',modelVersion,accessGrantVersion:'extraction-only-grant',dataHandlingVersion:'fixture-no-retention',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z'},surface:{converse:async input=>{calls++;expect(input.modelId).toBe(modelVersion);expect(input.messages[0]!.content[0]!.text).toBe(label.syntheticText);return response;}}});
  await runOnce(selected.fixture.db,{registry:registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composition}),owner:'captured-sonnet-native',limit:20});
  const processed=crmProcessingResultSchema.parse((await selected.post('/crm/processing/read',{source})).body);
  expect(processed).toMatchObject({state:'complete',financial:{dispatchState:'settled'}});
  expect(processed.claims.map(claim=>claim.quote).sort()).toEqual(response.output.message.content[0]!.toolUse.input.claims.map(claim=>claim.quote).sort());
  expect(calls).toBe(1);
 }finally{await selected.fixture.stop();}
});

it.each([
 {name:'unique raw original',text:'Mira says: promise.',locator:'text:0:8',expected:'text:11:19',hashMatches:true},
 {name:'valid repeated',text:'promise. promise.',locator:'text:9:17',expected:'text:9:17',hashMatches:true},
 {name:'ambiguous repeated',text:'promise. promise.',locator:'text:1:9',expected:'text:1:9',hashMatches:true},
 {name:'mismatched original hash',text:'Mira says: promise.',locator:'text:0:8',expected:'text:0:8',hashMatches:false},
])('normalizes only trusted selected-original positions at the provider seam: $name',async example=>{
 const source={workspaceId:randomUUID(),sourceId:randomUUID(),kind:'selected_note' as const,revision:1,contentHash:example.hashMatches?createHash('sha256').update(example.text).digest('hex'):'a'.repeat(64),locator:null};
 const adapter=createBedrockCrmExtractionAdapter({endpointId:'controlled-extraction',modelVersion:'us.anthropic.claude-sonnet-4-6',accessGrantVersion:'grant',dataHandlingVersion:'policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{converse:async()=>({stopReason:'tool_use',usage:{inputTokens:50,outputTokens:30},output:{message:{role:'assistant',content:[{toolUse:{type:'tool_use',toolUseId:'controlled-position',name:'emit_crm_extraction',input:{claims:[{kind:'need',interpretation:'Explicit request',status:'stated',quote:'promise.',locator:example.locator}]}}}]}}})}});
 const result=await adapter.run({source,text:example.text,maxOutputTokens:4096,signal:new AbortController().signal});
 expect(result).toMatchObject({acceptance:'accepted',usage:{inputTokens:50,outputTokens:30},claims:[{locator:example.expected,quote:'promise.'}]});
});


it.each(['server_tool_use','action_type','action_name','multiple_tools','action_claim'])('refuses output action/protocol broadening with conserved known usage: %s',async mode=>{
 const selected=await selectedOriginal('Repairs need coordination.');
 try{
  const source={workspaceId:selected.fixture.alpha.workspaceId,sourceId:selected.sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(selected.text).digest('hex'),locator:null};
  await selected.fixture.db.query("INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,1,true,'controlled-extraction','us.anthropic.claude-sonnet-4-6','extraction-only-grant','fixture-no-retention',100,1000,1,1,$2)",[selected.fixture.alpha.workspaceId,selected.fixture.alpha.admin.userId]);
  expect((await selected.post('/crm/processing/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,source})).status).toBe(200);
  let calls=0;
  const composition=composeCrmBedrock({allowControlledEvaluation:true,extraction:{endpointId:'controlled-extraction',modelVersion:'us.anthropic.claude-sonnet-4-6',accessGrantVersion:'extraction-only-grant',dataHandlingVersion:'fixture-no-retention',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z'},surface:{converse:async()=>{
   calls++;
   const toolUse={type:mode==='server_tool_use'?'server_tool_use':mode==='action_type'?'send_email':'tool_use',toolUseId:'controlled-refusal',name:mode==='action_name'?'send_email':'emit_crm_extraction',input:{claims:[{kind:mode==='action_claim'?'send_email':'need',interpretation:'Coordination',status:'stated',quote:selected.text,locator:'text:0:26'}]}};
   return {stopReason:'tool_use',usage:{inputTokens:50,outputTokens:30},output:{message:{role:'assistant',content:mode==='multiple_tools'?[{toolUse},{toolUse}]:[{toolUse}]}}};
  }}});
  await runOnce(selected.fixture.db,{registry:registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composition}),owner:'native-protocol-refusal',limit:20});
  expect((await selected.post('/crm/processing/read',{source})).body).toMatchObject({state:'failed',reason:'invalid_extraction',claims:[],financial:{dispatchState:'settled',settledCents:1}});
  expect(calls).toBe(1);
 }finally{await selected.fixture.stop();}
});
