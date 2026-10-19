import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {workerDueWorkSources} from '../../worker/src/bootstrap/main.ts';
import {runSchedulerPass} from '../../worker/src/scheduler/schedulerPass.ts';
import { randomUUID, createHash } from 'node:crypto';
import { seedFirm } from './support/crmSeed.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { crmExtractJobHandler } from '../../worker/src/handlers/crmExtract.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import {activateForwardFixture,seedHistoricalExtraction} from './support/crmForwardScopeFixture.ts';
import type {SourceLookup} from '@fss/domain/crm/sourceResolver.ts';

let fixture: AuthFixture;
  let token: string;
  let forward:Awaited<ReturnType<typeof activateForwardFixture>>;
  async function activatePurpose(){
    forward??=await activateForwardFixture(fixture);
    await forward.extraction({endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',dailyCeilingCents:100,monthlyCeilingCents:100,inputTokenPriceMicros:2,outputTokenPriceMicros:8});
    return forward;
  }
  async function selectedSource(name:string,excerpt:string){
    const created=await forward.post('/crm/people/create',command({fullName:name}));
    const personId=(created.body as {result:{personId:string}}).result.personId;
    return {personId,source:await forward.original(excerpt)};
  }
  const historical=(source:SourceLookup,claims:Parameters<typeof seedHistoricalExtraction>[1]['claims']=[],historicalUnknownCents?:number)=>seedHistoricalExtraction(fixture,{source,claims,requestedBy:fixture.alpha.salesperson.userId,...(historicalUnknownCents===undefined?{}:{historicalUnknownCents})});
  let nativeCallSource: {workspaceId:string;sourceId:string;kind:string;revision:number;contentHash:string;locator:string}|null=null;
  const post = (path: string, body: unknown) => dispatch({
    method: 'POST', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` }, body,
  }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
  const get = (path:string,query:URLSearchParams)=>dispatch({method:'GET',path,query,headers:{authorization:`Bearer ${token}`},body:null},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,integrations:{publicOrigin:'https://fixture.example.test',calcom:null,twilio:{accountSid:'fixture',twimlAppSid:'fixture',callerIdE164:'+14015550100',verifySignature:()=>false,mintAccessToken:()=>{throw new Error('No calling');},fetchRecording:async()=>{throw new Error('No provider fetch');}}}});
  const command = (fields: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
  async function historicalSelectedSource(name:string,excerpt:string){
    const created=await post('/crm/people/create',command({fullName:name}));
    const personId=(created.body as {result:{personId:string}}).result.personId;
    await post('/crm/people/source/add',command({personId,sourceKey:name,excerpt,occurredAt:'2026-10-01T14:00:00Z'}));
    const page=await post('/crm/people/read',{personId});
    const value=(page.body as {sources:{workspaceId:string;sourceId:string;revision:number;contentHash:string}[]}).sources[0]!;
    return {personId,source:{workspaceId:value.workspaceId,sourceId:value.sourceId,kind:'selected_note' as const,revision:value.revision,contentHash:value.contentHash,locator:null}};
  }
describe('canonical CRM evidence and extraction', () => {
  beforeAll(async () => {
    fixture = await createAuthFixture();
    token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  });
  afterAll(async () => { await fixture.stop(); });
  it('resolves a selected original passage at its exact source revision through the authenticated evidence read', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Casey Morgan' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    expect((await post('/crm/people/source/add', command({
      personId, sourceKey: 'repair-evidence', excerpt: 'We need help coordinating repairs.', occurredAt: '2026-10-01T14:00:00.000Z',
    }))).status).toBe(200);
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const resolved = await post('/crm/processing/source/read', {
      workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash, locator: 'text:0:12',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      state: 'available', passage: { text: 'We need help', locator: 'text:0:12', speaker: null },
      source: { sourceId: source.sourceId, revision: 1, kind: 'selected_note', occurredAt: '2026-10-01T14:00:00.000Z', completeness: 'selected_excerpt' },
    });
  });
  it('reads exact source metadata for processing without returning the copied text', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Metadata reader' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: 'metadata-only', excerpt: 'Original note.', occurredAt: '2026-10-01T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const metadata = await post('/crm/processing/source/read', {
      workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash, locator: null,
    });
    expect(metadata.status).toBe(200);
    expect(metadata.body).toMatchObject({ state: 'available', passage: null, extent: { unit: 'utf16', length: 14 },
      source: { sourceId: source.sourceId, revision: 1, locator: null, speaker: null } });
    expect(JSON.stringify(metadata.body)).not.toContain('Original note.');
  });

  it('refuses a citation locator that splits an original Unicode character', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Unicode correspondent' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: 'unicode-source', excerpt: 'A😀B', occurredAt: '2026-10-01T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const lookup = { workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash };
    expect((await post('/crm/processing/source/read', { ...lookup, locator: 'text:1:2' })).status).toBe(404);
    expect((await post('/crm/processing/source/read', { ...lookup, locator: 'text:2:3' })).status).toBe(404);
    const resolved = await post('/crm/processing/source/read', { ...lookup, locator: 'text:1:3' });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ passage: { text: '😀' } });
  });

  it('retains one exact-source processing generation and reports missing purpose configuration without claiming extraction', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Processing correspondent' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: 'processing-source', excerpt: 'We need a repair coordinator.', occurredAt: '2026-10-01T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const lookup = { workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash, locator: null };
    const requested = await post('/crm/processing/request', command({ source: lookup }));
    expect(requested.status).toBe(409);
    expect(requested.body).toMatchObject({ reason: 'extraction_source_scope_unavailable' });
    const processing = await post('/crm/processing/read', { source: lookup });
    expect(processing.status).toBe(200);
    expect(processing.body).toMatchObject({ state: 'not_requested', claims: [] });
    const repeated = await post('/crm/processing/request', command({ source: lookup }));
    expect(repeated.status).toBe(409);
    expect((await fixture.db.query('SELECT id FROM crm_extraction_generations WHERE workspace_id=$1 AND source_id=$2',[fixture.alpha.workspaceId,source.sourceId])).rows).toHaveLength(0);
    expect(JSON.stringify(processing.body)).not.toContain('We need a repair coordinator.');
  });

  it('reports absent extraction purpose and zero allowances without inheriting another model permission', async () => {
    const settings = await post('/crm/processing/purpose/read', {});
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ enabled: false, configured: false, modelVersion: null, endpoint: null,
      dailyCeilingCents: 0, monthlyCeilingCents: 0, unavailableReason: 'purpose_not_configured' });
  });

  it('lets an administrator save a revision-bound purpose and budget while activation remains unavailable', async () => {
    const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const adminPost = (body: unknown) => dispatch({ method: 'POST', path: '/crm/processing/purpose/save',
      query: new URLSearchParams(), headers: { authorization: `Bearer ${adminToken}` }, body },
      { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
    const purpose = { expectedRevision: 0, enabled: false, endpointId: 'evaluation-adapter', modelVersion: 'fixture-model-v1',
      accessGrantVersion: 'fixture-purpose-grant-v1', dataHandlingVersion: 'fixture-data-policy-v1',
      dailyCeilingCents: 10, monthlyCeilingCents: 100, inputTokenPriceMicros: 2, outputTokenPriceMicros: 8 };
    expect((await post('/crm/processing/purpose/save', command(purpose))).status).toBe(409);
    const activation = await adminPost(command({ ...purpose, enabled: true }));
    expect(activation.status).toBe(409);
    expect(activation.body).toMatchObject({ reason: 'activation_not_available' });
    const saved = await adminPost(command(purpose));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ result: { revision: 1, enabled: false } });
    expect((await post('/crm/processing/purpose/read', {})).body).toMatchObject({ configured: true, enabled: false,
      revision: 1, endpointId: 'evaluation-adapter', modelVersion: 'fixture-model-v1',
      unavailableReason: 'activation_not_available', dailyCeilingCents: 10 });
    expect((await adminPost(command(purpose))).status).toBe(409);
  });

  it('binds a requested generation to the configured purpose revision while retaining the activation refusal', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Configured processing correspondent' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: 'configured-source', excerpt: 'Please send the pricing.', occurredAt: '2026-10-01T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const lookup = { workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash, locator: null };
    const requested = await post('/crm/processing/request', command({ source: lookup }));
    expect(requested.status).toBe(409);
    expect(requested.body).toMatchObject({reason:'extraction_source_scope_unavailable'});
    const processing = await post('/crm/processing/read', { source: lookup });
    expect(processing.body).toMatchObject({state:'not_requested',claims:[]});
  });

  it('shows deleted processing coverage without exposing the removed source or reviving its generation on restore', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Deleted processing correspondent' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: 'deleted-processing-source', excerpt: 'Confidential repair notes.', occurredAt: '2026-10-01T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const lookup = { workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash, locator: null };
    expect((await post('/crm/processing/request', command({ source: lookup }))).status).toBe(409);
    await historical({...lookup,kind:'selected_note'});
    const deleted = await post('/crm/people/source/delete', command({ personId, sourceId: source.sourceId, expectedRevision: 1 }));
    expect(deleted.status).toBe(200);
    const health = await post('/crm/processing/health/read', { sourceId: source.sourceId, kind: 'selected_note' });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ availability: 'deleted', generations: [{ state: 'deleted', reason: 'source_deleted' }] });
    expect(JSON.stringify(health.body)).not.toContain('Confidential repair notes.');
    expect((await post('/crm/processing/source/read', lookup)).status).toBe(404);
    expect((await post('/crm/people/source/restore', command({ personId, sourceId: source.sourceId, expectedRevision: 2 }))).status).toBe(200);
    expect((await post('/crm/processing/health/read', { sourceId: source.sourceId, kind: 'selected_note' })).body)
      .toMatchObject({ availability: 'awaiting_recapture', generations: [{ state: 'deleted' }] });
  });

  it('resolves an exact native meeting utterance with original speaker and date without copying it into a note', async () => {
    const firmId = await seedFirm(fixture,{name:'Native extraction firm',regionCode:'TX',assignedUserId:fixture.alpha.salesperson.userId});
    const meetingId=randomUUID(),recordingId=randomUUID(),transcriptId=randomUUID();
    await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'crm-native','crm-native','booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",[fixture.alpha.workspaceId,meetingId,firmId]);
    await fixture.db.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Selected transcript',$4,100,$5,'ready')",[fixture.alpha.workspaceId,recordingId,meetingId,'a'.repeat(64),`meetings/${meetingId}/${'a'.repeat(64)}.m4a`]);
    const utterances=[{startMs:0,endMs:5000,text:'We need a repair coordinator.',speaker:'Shirley',attribution:'source_label'}];
    await fixture.db.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)",[fixture.alpha.workspaceId,transcriptId,recordingId,JSON.stringify(utterances)]);
    const lookup={workspaceId:fixture.alpha.workspaceId,kind:'meeting_transcript',sourceId:transcriptId,revision:1,contentHash:createHash('sha256').update(JSON.stringify(utterances)).digest('hex'),locator:'utterance:0:text:0:12'};
    const resolved=await post('/crm/processing/source/read',lookup);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({source:{kind:'meeting_transcript',sourceId:transcriptId,occurredAt:'2026-10-01T14:00:00.000Z'},passage:{text:'We need a re',speaker:'Shirley'}});
    await fixture.db.query('UPDATE firms SET assigned_user_id=$2 WHERE workspace_id=$3 AND id=$1',[firmId,fixture.alpha.admin.userId,fixture.alpha.workspaceId]);
    expect((await post('/crm/processing/source/read',lookup)).status).toBe(404);
  });

  it('reads historical generations for changed explicit context and keeps review flags in the same context without native activation',async()=>{
    const {personId,source}=await historicalSelectedSource('Changing original context','We work with both firms.');
    const beforeId=await historical(source);
    const first=await post('/crm/processing/read',{source});expect(first.status).toBe(200);
    const firmId=await seedFirm(fixture,{name:'Explicit context firm',assignedUserId:fixture.alpha.salesperson.userId});
    const evidence={sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash};
    const relationship=await post('/crm/relationships/save',command({personId,firmId,status:'current',startDate:'2026-01-01',endDate:null,evidence}));expect(relationship.status).toBe(200);
    const relation=(relationship.body as {result:{relationshipId:string;revision:number}}).result;
    expect((await post('/crm/relationships/context/save',command({personId,relationshipId:relation.relationshipId,relationshipRevision:relation.revision,evidence}))).status).toBe(200);
    // Pre119 retained snapshot history only. New native work is refused, so
    // this offline historical supersession is not a new processing command.
    expect((await post('/crm/processing/request',command({source}))).status).toBe(409);
    await fixture.db.query("UPDATE crm_extraction_generations SET state='stale',reason='source_context_changed' WHERE workspace_id=$1 AND id=$2",[fixture.alpha.workspaceId,beforeId]);
    await historical(source);
    const second=await post('/crm/processing/read',{source});expect(second.status).toBe(200);
    const before={...(first.body as {generationId:string;contextHash:string}),generationId:beforeId};const after=second.body as {generationId:string;contextHash:string};
    expect(after.generationId).not.toBe(before.generationId);expect(after.contextHash).toMatch(/^[a-f0-9]{64}$/);expect(after.contextHash).not.toBe(before.contextHash);
    expect((await post('/crm/processing/health/read',{kind:source.kind,sourceId:source.sourceId})).body).toMatchObject({generations:expect.arrayContaining([expect.objectContaining({generationId:before.generationId,state:'stale',reason:'source_context_changed',contextHash:before.contextHash})])});
    expect((await post('/crm/relationships/correct',command({personId,firmId,status:'historical',startDate:'2026-01-01',endDate:'2026-01-02',evidence,relationshipId:relation.relationshipId,expectedRevision:relation.revision}))).status).toBe(200);
    const reviewed=await post('/crm/processing/read',{source});expect(reviewed.body).toMatchObject({generationId:after.generationId,contextHash:after.contextHash});
  });

  it('durably enqueues extraction through the normal command and completes unavailable coverage without a model', async () => {
    const {post}=await activatePurpose();
    const exact=await forward.original('We need faster repairs.');
    expect((await post('/crm/processing/request',command({source:exact}))).status).toBe(200);
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,}));
    const report=await runOnce(fixture.db,{registry,owner:'crm-extraction-test',limit:10});
    expect(report.claimed).toBeGreaterThan(0);
    expect((await post('/crm/processing/read',{source:exact})).body).toMatchObject({state:'unavailable',claims:[]});
  });

  it('extracts an exact quoted need through the registered fake purpose adapter with conservative cent accounting', async () => {
    const {post}=await activatePurpose();
    const {personId,source:captured}=await selectedSource('Extracted needs','We need faster repairs.');
    expect((await post('/crm/business/mail/associate',command({sourceId:captured.sourceId,expectedRevision:captured.revision,personId}))).status).toBe(200);
    const source={...captured,revision:captured.revision+1};
    const requested=await post('/crm/processing/request',command({source}));expect(requested.status).toBe(200);
    const registry=new HandlerRegistry();
    registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>({acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Faster repairs',status:'stated',locator:'text:0:23',quote:'We need faster repairs.'}]})}}));
    await runOnce(fixture.db,{registry,owner:'crm-paid-fixture',limit:20});
    const processed=await post('/crm/processing/read',{source});
    expect(processed.status).toBe(200);
    expect(processed.body).toMatchObject({state:'complete',claims:[{context:{personId,firmIds:[],relationships:[],review:'current'},claimRevision:1,kind:'need',status:'stated',quote:'We need faster repairs.',source:{sourceId:source.sourceId,revision:source.revision,occurredAt:expect.any(String)}}],financial:{dispatchState:'settled',settledCents:1}});
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

  it('keeps an unknown paid acceptance visible after deletion and blocks repeating the same source after explicit recapture',async()=>{
    const {post}=await activatePurpose();
    const at=Date.now(),messageId=randomUUID();
    const get=()=>forward.original('A confidential promise.',{at,messageId});
    const source=await get();await post('/crm/processing/request',command({source}));let calls=0;
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;throw new Error('Acceptance unknown');}}}));
    await runOnce(fixture.db,{registry,owner:'crm-unknown-fixture',limit:20});
    expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'unknown_acceptance',financial:{dispatchState:'unknown_acceptance',settledCents:4}});
    await post('/crm/business/mail/delete',command({sourceId:source.sourceId,expectedRevision:source.revision}));
    const health=await post('/crm/processing/health/read',{sourceId:source.sourceId,kind:source.kind});
    expect(health.body).toMatchObject({availability:'deleted',generations:[{state:'deleted',financial:{dispatchState:'unknown_acceptance',settledCents:4}}]});
    expect(JSON.stringify(health.body)).not.toContain('A confidential promise.');
    await post('/crm/business/mail/restore',command({sourceId:source.sourceId,expectedRevision:2}));
    await post('/crm/business/mail/recapture',command({sourceId:source.sourceId,expectedRevision:3}));
    const recaptured=await get();await post('/crm/processing/request',command({source:recaptured}));await runOnce(fixture.db,{registry,owner:'crm-unknown-fixture',limit:20});
    expect(calls).toBe(1);expect((await post('/crm/processing/read',{source:recaptured})).body).toMatchObject({state:'unknown_acceptance',reason:'prior_acceptance_unknown',claims:[]});
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

  it('bounds a provider wait and retains unknown money without submitting again',async()=>{
    const {post}=await activatePurpose();
    const source=await forward.original('Pending source.');await post('/crm/processing/request',command({source}));let calls=0;
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,providerTimeoutMs:5,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return new Promise(()=>{});}}}));
    await runOnce(fixture.db,{registry,owner:'crm-timeout-fixture',limit:20});
    expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'unknown_acceptance',claims:[],financial:{dispatchState:'unknown_acceptance',settledCents:4}});
    await post('/crm/processing/request',command({source}));await runOnce(fixture.db,{registry,owner:'crm-timeout-fixture',limit:20});expect(calls).toBe(1);
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  },1000);

  it('preserves native source storage without attempting a newly unauthorized CRM successor',async()=>{
    const {post}=await activatePurpose();
    const created=await post('/crm/people/create',command({fullName:'Atomic captured source'}));const personId=(created.body as {result:{personId:string}}).result.personId;
    await fixture.database.session.query("CREATE FUNCTION fixture_refuse_crm_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='crm.extract' THEN RAISE EXCEPTION 'fixture_enqueue_failure'; END IF; RETURN NEW; END; $$");
    await fixture.database.session.query('CREATE TRIGGER fixture_refuse_crm_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION fixture_refuse_crm_job()');
    try{expect((await post('/crm/people/source/add',command({personId,sourceKey:'rollback-source',excerpt:'This native capture must survive.',occurredAt:'2026-10-01T14:00:00Z'}))).status).toBe(200);}
    finally{await fixture.database.session.query('DROP TRIGGER fixture_refuse_crm_job ON jobs');await fixture.database.session.query('DROP FUNCTION fixture_refuse_crm_job()');await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);}
    expect((await post('/crm/people/read',{personId})).body).toMatchObject({sources:[{excerpt:'This native capture must survive.'}]});
  });

  it('reads historical native meeting evidence without new extraction consent or selected-note copying',async()=>{
    const firmId=await seedFirm(fixture,{name:'Native processed meeting',regionCode:'TX',assignedUserId:fixture.alpha.salesperson.userId});const meetingId=randomUUID(),recordingId=randomUUID(),transcriptId=randomUUID();
    await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'crm-processed-native','crm-processed-native','booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",[fixture.alpha.workspaceId,meetingId,firmId]);
    await fixture.db.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Selected transcript',$4,100,$5,'ready')",[fixture.alpha.workspaceId,recordingId,meetingId,'a'.repeat(64),`meetings/${meetingId}/${'a'.repeat(64)}.m4a`]);
    const utterances=[{startMs:0,endMs:5000,text:'We need repairs.',speaker:'Shirley',attribution:'source_label'}];await fixture.db.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)",[fixture.alpha.workspaceId,transcriptId,recordingId,JSON.stringify(utterances)]);
    const source={workspaceId:fixture.alpha.workspaceId,kind:'meeting_transcript',sourceId:transcriptId,revision:1,contentHash:createHash('sha256').update(JSON.stringify(utterances)).digest('hex'),locator:null};
    const nativePage=await get('/meetings/transcript',new URLSearchParams({meetingId,include:'processing'}));expect(nativePage.status).toBe(200);expect(nativePage.body).toMatchObject({processingSources:[{...source,completeness:'partial',availability:'available'}]});
    expect((await get('/meetings/transcript',new URLSearchParams({meetingId}))).body).not.toHaveProperty('processingSources');
    expect((await post('/crm/processing/request',command({source}))).status).toBe(409);
    await historical({...source,kind:'meeting_transcript'},[{kind:'need',interpretation:'Repairs',status:'stated',locator:'utterance:0:text:0:16',quote:'We need repairs.'}]);
    expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'complete',claims:[{quote:'We need repairs.',source:{kind:'meeting_transcript',sourceId:transcriptId,speaker:'Shirley',occurredAt:'2026-10-01T14:00:00.000Z'}}]});
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

  it('keeps native record financial health after transcript deletion without exposing it to a new assignee',async()=>{
    const firmId=await seedFirm(fixture,{name:'Native erased meeting',regionCode:'TX',assignedUserId:fixture.alpha.salesperson.userId});const meetingId=randomUUID(),recordingId=randomUUID(),transcriptId=randomUUID();
    await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'crm-deleted-native','crm-deleted-native','booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",[fixture.alpha.workspaceId,meetingId,firmId]);
    await fixture.db.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Selected transcript',$4,100,$5,'ready')",[fixture.alpha.workspaceId,recordingId,meetingId,'a'.repeat(64),`meetings/${meetingId}/${'a'.repeat(64)}.m4a`]);
    const utterances=[{startMs:0,endMs:5000,text:'We need repairs.',speaker:'Shirley',attribution:'source_label'}];await fixture.db.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)",[fixture.alpha.workspaceId,transcriptId,recordingId,JSON.stringify(utterances)]);
    const source={workspaceId:fixture.alpha.workspaceId,kind:'meeting_transcript',sourceId:transcriptId,revision:1,contentHash:createHash('sha256').update(JSON.stringify(utterances)).digest('hex'),locator:null};
    const nativePage=await get('/meetings/transcript',new URLSearchParams({meetingId,include:'processing'}));expect(nativePage.status).toBe(200);expect(nativePage.body).toMatchObject({processingSources:[{...source,completeness:'partial',availability:'available'}]});
    expect((await get('/meetings/transcript',new URLSearchParams({meetingId}))).body).not.toHaveProperty('processingSources');
    expect((await post('/crm/processing/request',command({source}))).status).toBe(409);
    await historical({...source,kind:'meeting_transcript'},[],4);
    await fixture.db.query('DELETE FROM meeting_transcripts WHERE workspace_id=$1 AND id=$2',[fixture.alpha.workspaceId,transcriptId]);
    const health=await post('/crm/processing/record/read',{kind:'meeting',recordId:meetingId});expect(health.status).toBe(200);
    expect(health.body).toMatchObject({sources:[{sourceId:transcriptId,availability:'deleted',unknownAcceptance:true,generations:[{state:'deleted',claims:[],financial:{dispatchState:'unknown_acceptance',settledCents:4}}]}]});
    expect(JSON.stringify(health.body)).not.toContain('We need repairs.');
    await fixture.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'salesperson','active') ON CONFLICT DO NOTHING",[fixture.alpha.workspaceId,fixture.beta.salesperson.userId]);
    await fixture.db.query('UPDATE firms SET assigned_user_id=$2 WHERE workspace_id=$1 AND id=$3',[fixture.alpha.workspaceId,fixture.beta.salesperson.userId,firmId]);
    const oldToken=token;token=(await issueSessionFor(fixture,fixture.alpha,fixture.beta.salesperson)).accessToken;
    try{expect((await post('/crm/processing/record/read',{kind:'meeting',recordId:meetingId})).body).toMatchObject({sources:[]});expect((await post('/crm/processing/health/read',{sourceId:transcriptId,kind:'meeting_transcript'})).status).toBe(404);}
    finally{token=oldToken;await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);}
  });

  it.each(['body','assignment'] as const)('keeps displayed native speech and processing authority coherent across %s change',async mode=>{
    const ws=fixture.alpha.workspaceId,firmId=await seedFirm(fixture,{name:'Native reference race',regionCode:'TX',assignedUserId:fixture.alpha.salesperson.userId});
    const meetingId=randomUUID(),recordingId=randomUUID(),transcriptId=randomUUID(),booking=randomUUID();
    await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,$4,$4,'booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",[ws,meetingId,firmId,booking]);
    await fixture.db.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Selected transcript',$4,100,$5,'ready')",[ws,recordingId,meetingId,'b'.repeat(64),`meetings/${meetingId}/${'b'.repeat(64)}.m4a`]);
    const original=[{startMs:0,endMs:5000,text:'Original private speech.',speaker:'Unknown',attribution:'source_label'}],corrected=[{...original[0],text:'Corrected private speech.'}];
    await fixture.db.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)",[ws,transcriptId,recordingId,JSON.stringify(original)]);
    let changed=false;
    const wrapped:SessionQueryable={query:async <Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
      const result=await fixture.db.query<Row>(sql,values);
      if(!changed&&((mode==='body'&&sql==='SELECT transcript_source_revision FROM meetings WHERE workspace_id=$1 AND id=$2')||(mode==='assignment'&&sql==='SELECT assigned_user_id,status FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE'))){
        changed=true;
        if(mode==='body')await fixture.db.query('UPDATE meeting_transcripts SET utterances=$3::jsonb WHERE workspace_id=$1 AND id=$2',[ws,transcriptId,JSON.stringify(corrected)]);
        else await fixture.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[ws,firmId,fixture.alpha.admin.userId]);
      }
      return result;
    }};
    const result=await dispatch({method:'GET',path:'/meetings/transcript',query:new URLSearchParams({meetingId,include:'processing'}),headers:{authorization:`Bearer ${token}`},body:null},{session:wrapped,auth:{...fixture.deps,db:wrapped},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
    expect(changed).toBe(true);
    if(mode==='assignment')expect(result.status).toBe(404);
    else if(result.status===200)expect(result.body).toMatchObject({utterances:[{text:'Corrected private speech.'}],processingSources:[{contentHash:createHash('sha256').update(JSON.stringify(corrected)).digest('hex')}]});
    else expect(result.status).toBe(404);
  });

  it('resolves native call speech with channel attribution and preserves an unknown original call date',async()=>{
    const ws=fixture.alpha.workspaceId,user=fixture.alpha.salesperson.userId;
    const firmId=await seedFirm(fixture,{name:'Native call source',regionCode:'RI',assignedUserId:user});const callId=randomUUID();
    const route=(await fixture.db.query<{id:string}>("INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,'+14015550123','research_provider',now(),0.9,'passed','usable','route.1') RETURNING id",[ws,firmId])).rows[0]!.id;
    const identity=(await fixture.db.query<{id:string}>("INSERT INTO calling_identities(workspace_id,owner_user_id,e164,verification_status,enabled,verified_at,verified_by_user_id,verification_method) VALUES($1,$2,'+14015550124','verified',false,now(),$2,'owner_attestation') RETURNING id",[ws,user])).rows[0]!.id;
    const posture=(await fixture.db.query<{id:string}>("INSERT INTO state_postures(workspace_id,state,revision,effective_from,review_at,rules_revision,confirmed_statements,confirmed_by_user_id) VALUES($1,'RI',1,'2026-01-01','2027-01-01',2,ARRAY['businessToBusiness'],$2) RETURNING id",[ws,fixture.alpha.admin.userId])).rows[0]!.id;
    const device=(await fixture.db.query<{id:string}>('SELECT id FROM devices WHERE workspace_id=$1 AND user_id=$2 LIMIT 1',[ws,user])).rows[0]!.id;
    const ticket=(await fixture.db.query<{id:string}>("INSERT INTO dial_tickets(workspace_id,command_id,firm_id,phone_route_id,route_version,posture_id,posture_revision,calling_identity_id,actor_user_id,device_id,assigned_user_id,e164,firm_time_zone,expires_at) VALUES($1,'crm-call-fixture',$2,$3,1,$4,1,$5,$6,$7,$6,'+14015550123','America/New_York',now()+interval '30 seconds') RETURNING id",[ws,firmId,route,posture,identity,user,device])).rows[0]!.id;
    const reservation=(await fixture.db.query<{id:string}>("INSERT INTO provider_reservations(workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros,state,settled_at) VALUES($1,'twilio.voice','call_session',$2,1,current_date,'America/New_York',0,NULL,NULL,NULL,'minute',1,0,'released',now()) RETURNING id",[ws,callId])).rows[0]!.id;
    await fixture.db.query("INSERT INTO call_sessions(workspace_id,id,ticket_id,firm_id,actor_user_id,reservation_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 seconds')",[ws,callId,ticket,firmId,user,reservation]);
    const utterances=[{speaker:1,start:0,end:5,text:'We need repairs.'}];await fixture.db.query("INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances) VALUES($1,$2,'aws_transcribe','standard','en-US',5,$3::jsonb)",[ws,callId,JSON.stringify(utterances)]);
    const source={workspaceId:ws,sourceId:callId,kind:'call_transcript',revision:1,contentHash:createHash('sha256').update(JSON.stringify(utterances)).digest('hex'),locator:'utterance:0:text:0:16'};
    await fixture.db.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value) VALUES($1,'calling_provider',1,'{\"provider\":\"twilio\"}'::jsonb)",[ws]);
    const nativePage=await get('/calls/transcript',new URLSearchParams({callSessionId:callId,include:'processing'}));expect(nativePage.status).toBe(200);expect(nativePage.body).toMatchObject({processingSource:{...source,locator:null,completeness:'partial',availability:'available'}});
    expect((await get('/calls/transcript',new URLSearchParams({callSessionId:callId}))).body).not.toHaveProperty('processingSource');
    nativeCallSource=source;
    const result=await post('/crm/processing/source/read',source);expect(result.status).toBe(200);expect(result.body).toMatchObject({source:{kind:'call_transcript',sourceId:callId,occurredAt:null},passage:{text:'We need repairs.',speaker:'channel:1'}});
  });

  it('keeps native call processing health while a corrected original invalidates old work',async()=>{
    if(nativeCallSource===null)throw new Error('Native source fixture missing');
    const source={...nativeCallSource,kind:'call_transcript' as const,locator:null};expect((await post('/crm/processing/request',command({source}))).status).toBe(409);
    await historical(source);
    await fixture.db.query('UPDATE call_transcripts SET utterances=$3::jsonb WHERE workspace_id=$1 AND call_session_id=$2',[source.workspaceId,source.sourceId,JSON.stringify([{speaker:1,start:0,end:5,text:'Corrected speech.'}])]);
    const health=await post('/crm/processing/health/read',{kind:'call_transcript',sourceId:source.sourceId});expect(health.status).toBe(200);expect(health.body).toMatchObject({sourceRevision:2,availability:'available',generations:[{sourceRevision:1,state:'stale',reason:'source_changed',claims:[]}]});
    expect((await post('/crm/processing/source/read',source)).status).toBe(404);
    const firm=(await fixture.db.query<{firm_id:string}>('SELECT firm_id FROM call_sessions WHERE workspace_id=$1 AND id=$2',[source.workspaceId,source.sourceId])).rows[0]!.firm_id;
    await fixture.db.query('UPDATE firms SET assigned_user_id=$2 WHERE workspace_id=$1 AND id=$3',[source.workspaceId,fixture.beta.salesperson.userId,firm]);
    const originalToken=token;token=(await issueSessionFor(fixture,fixture.alpha,fixture.beta.salesperson)).accessToken;
    const corrected={...source,revision:2,contentHash:createHash('sha256').update(JSON.stringify([{speaker:1,start:0,end:5,text:'Corrected speech.'}])).digest('hex')};
    try{expect((await post('/crm/processing/read',{source:corrected})).status).toBe(404);expect((await post('/crm/processing/request',command({source:corrected}))).status).toBe(409);}
    finally{token=originalToken;await fixture.db.query('UPDATE firms SET assigned_user_id=$2 WHERE workspace_id=$1 AND id=$3',[source.workspaceId,fixture.alpha.salesperson.userId,firm]);}
  });

  it('holds no CRM locks over a provider wait and discards output after source deletion while conserving payment',async()=>{
    const {post}=await activatePurpose();
    const source=await forward.original('Confidential source.');await post('/crm/processing/request',command({source}));
    let release!:()=>void;let started!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{started();await waiting;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Confidential',status:'stated',locator:'text:0:20',quote:'Confidential source.'}]};}}}));
    const session=await fixture.database.appRuntimeSession();const running=runOnce(session,{registry,owner:'crm-delete-wait-fixture',limit:20});
    await entered;
    try{
      expect((await post('/crm/people/create',command({fullName:'Unrelated concurrent work'}))).status).toBe(200);
      expect((await post('/crm/business/mail/delete',command({sourceId:source.sourceId,expectedRevision:source.revision}))).status).toBe(200);
    }finally{release();}
    await running;
    expect((await post('/crm/processing/health/read',{kind:source.kind,sourceId:source.sourceId})).body).toMatchObject({availability:'deleted',generations:[{state:'deleted',claims:[],financial:{dispatchState:'settled',settledCents:1}}]});
    expect((await post('/crm/processing/source/read',source)).status).toBe(404);
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

  it('distinguishes estimated whole-cent accounting from reported billed usage',async()=>{
    const {post}=await activatePurpose();
    const source=await forward.original('We need repairs.');await post('/crm/processing/request',command({source}));
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>({acceptance:'accepted',usage:null,claims:[{kind:'need',interpretation:'Repairs',status:'stated',locator:'text:0:16',quote:'We need repairs.'}]})}}));
    await runOnce(fixture.db,{registry,owner:'crm-estimated-fixture',limit:20});expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'complete',financial:{dispatchState:'settled',settlementState:'estimated',settledCents:4}});
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

  it('invalidates meeting evidence when its original body changes even at the same native version',async()=>{
    const firmId=await seedFirm(fixture,{name:'Meeting correction',regionCode:'TX',assignedUserId:fixture.alpha.salesperson.userId});
    const meetingId=randomUUID(),recordingId=randomUUID(),sourceId=randomUUID();
    await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,$2::uuid::text,$2::uuid::text,'booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",[fixture.alpha.workspaceId,meetingId,firmId]);
    await fixture.db.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Selected transcript',$4,100,$5,'ready')",[fixture.alpha.workspaceId,recordingId,meetingId,'b'.repeat(64),`meetings/${meetingId}/${'b'.repeat(64)}.m4a`]);
    const utterances=[{startMs:0,endMs:5000,text:'Original meeting text.',speaker:'Speaker 1',attribution:'unknown'}];
    await fixture.db.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)",[fixture.alpha.workspaceId,sourceId,recordingId,JSON.stringify(utterances)]);
    const source={workspaceId:fixture.alpha.workspaceId,sourceId,kind:'meeting_transcript',revision:1,contentHash:createHash('sha256').update(JSON.stringify(utterances)).digest('hex'),locator:null};
    expect((await post('/crm/processing/request',command({source}))).status).toBe(409);
    await historical({...source,kind:'meeting_transcript'});
    await fixture.db.query("UPDATE meeting_transcripts SET utterances=$3::jsonb WHERE workspace_id=$1 AND id=$2",[fixture.alpha.workspaceId,sourceId,JSON.stringify([{...utterances[0],text:'Corrected meeting text.'}])]);
    expect((await post('/crm/processing/health/read',{kind:source.kind,sourceId})).body).toMatchObject({generations:[{state:'stale',reason:'source_changed',claims:[]}]});
    expect((await post('/crm/processing/source/read',source)).status).toBe(404);
  });

  it('conserves reported usage but refuses publication when the provider exceeds the authorized token bounds',async()=>{
    const {post}=await activatePurpose();
    const {source}=await selectedSource('Exceeded extraction shape','Bounded source.');
    await post('/crm/processing/request',command({source}));
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>({acceptance:'accepted',usage:{inputTokens:90000,outputTokens:5000},claims:[]})}}));
    await runOnce(fixture.db,{registry,owner:'crm-invalid-usage',limit:20});
    expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'failed',reason:'provider_usage_exceeded',claims:[],financial:{dispatchState:'settled',settlementState:'settled',settledCents:22}});
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

  it('retains the conservative estimate when an unrepresentable provider charge would overflow the money ledger',async()=>{
    const {post}=await activatePurpose();
    const {source}=await selectedSource('Unrepresentable usage','Bounded source.');
    await post('/crm/processing/request',command({source}));
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>({acceptance:'accepted',usage:{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:Number.MAX_SAFE_INTEGER},claims:[]})}}));
    await runOnce(fixture.db,{registry,owner:'crm-invalid-usage',limit:20});
    expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'failed',reason:'provider_usage_exceeded',claims:[],financial:{dispatchState:'settled',settlementState:'estimated',settledCents:4}});
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

  it('does not turn a cash allowance into direct-paid fallback authority for a credits-only purpose',async()=>{
    const {post}=await activatePurpose(),source=await forward.original('No cash fallback.');
    expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
    let calls=0;
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:null,claims:[]};}}}));
    await runOnce(fixture.db,{registry,owner:'no-cash-fallback',limit:20});
    expect(calls).toBe(0);
    expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'unavailable',claims:[],financial:null});
  });
  it('conserves paid money but discards output when concurrent spend exhausts the credits allowance during the provider wait',async()=>{
    const {post}=await activatePurpose();
    const {source}=await selectedSource('Changed publication allowance','Exact budget evidence.');await post('/crm/processing/request',command({source}));
    let release!:()=>void,started!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{started();await wait;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[]};}}}));
    const session=await fixture.database.appRuntimeSession();const running=runOnce(session,{registry,owner:'crm-publication-budget',limit:20});await entered;
    const adminToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
    const update=(cents:number)=>dispatch({method:'POST',path:'/settings/update',query:new URLSearchParams(),headers:{authorization:`Bearer ${adminToken}`},body:command({settingKey:'monthly_cash_ceiling_cents',value:{cents}})},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
    const concurrentId=randomUUID();
    try{
      expect((await update(0)).status).toBe(200);
      // An independently incurred test-only ledger charge consumes the actual
      // credits purpose allowance, not the unrelated global cash ceiling.
      await fixture.db.query("INSERT INTO provider_reservations(workspace_id,id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,state,settled_cents,settled_at) SELECT $1,$2,'aws_bedrock.fixture','crm_extraction',$3,1,(clock_timestamp() AT TIME ZONE 'America/New_York')::date,'America/New_York',100,'fixture-model-v1',2000,4096,'settled',100,now()",[fixture.alpha.workspaceId,concurrentId,randomUUID()]);
    }finally{release();await running;}
    try{expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'failed',reason:'budget_authority_changed',claims:[],financial:{dispatchState:'settled',settledCents:1}});}finally{await update(2500);await fixture.db.query('DELETE FROM provider_reservations WHERE workspace_id=$1 AND id=$2',[fixture.alpha.workspaceId,concurrentId]);await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);}
  });

  it('recovers an expired dispatched lease as unknown acceptance without submitting again, even after deletion',async()=>{
    const {post}=await activatePurpose();
    const {source}=await selectedSource('Expired dispatch','Recoverable payment.');
    const requested=await post('/crm/processing/request',command({source}));
    const generationId=(requested.body as {result:{generationId:string}}).result.generationId;
    let release!:()=>void,started!:()=>void,calls=0;
    const wait=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;started();await wait;return {acceptance:'unknown',usage:null,claims:[]};}}}));
    const first=await fixture.database.appRuntimeSession(),second=await fixture.database.appRuntimeSession();
    const running=runOnce(first,{registry,owner:'crm-expired-first',limit:20});await entered;
    try{
      expect((await post('/crm/business/mail/delete',command({sourceId:source.sourceId,expectedRevision:source.revision}))).status).toBe(200);
      await fixture.db.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND payload->>'generationId'=$2 AND state='running'",[fixture.alpha.workspaceId,generationId]);
      await runOnce(second,{registry,owner:'crm-expired-reclaim',limit:20});
      await fixture.db.query("UPDATE jobs SET not_before=clock_timestamp()-interval '1 second',run_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND payload->>'generationId'=$2 AND state='queued'",[fixture.alpha.workspaceId,generationId]);
      await runOnce(second,{registry,owner:'crm-expired-second',limit:20});
      expect((await post('/crm/processing/health/read',{sourceId:source.sourceId,kind:source.kind})).body).toMatchObject({availability:'deleted',generations:[{state:'deleted',claims:[],financial:{dispatchState:'unknown_acceptance',settlementState:'estimated',settledCents:4}}]});
      expect(calls).toBe(1);
    }finally{release();await running;}
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

  it('materializes bounded body-free recovery for a dead dispatched job and retains its blocker',async()=>{
    const {post}=await activatePurpose();
    const {source}=await selectedSource('Dead dispatch recovery','Interrupted dispatch.');
    const requested=await post('/crm/processing/request',command({source}));const generationId=(requested.body as {result:{generationId:string}}).result.generationId;
    let release!:()=>void,started!:()=>void,calls=0;const wait=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;started();await wait;return {acceptance:'unknown',usage:null,claims:[]};}}}));
    const first=await fixture.database.appRuntimeSession(),second=await fixture.database.appRuntimeSession();const running=runOnce(first,{registry,owner:'crm-dead-first',limit:20});await entered;
    try{
      await fixture.db.query("UPDATE jobs SET state='dead',dead_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND payload->>'generationId'=$2 AND state='running'",[fixture.alpha.workspaceId,generationId]);
      const recovery=workerDueWorkSources().find(value=>value.name==='crm-processing-recovery');expect(recovery).toBeDefined();if(recovery===undefined)throw new Error('Recovery source absent');
      const report=await runSchedulerPass(second,{sources:[recovery],now:new Date().toISOString()});expect(report.externalActions).toBe(0);expect(report.inserted).toBe(1);
      await runOnce(second,{registry,owner:'crm-dead-recovery',limit:20});
      expect((await post('/crm/processing/health/read',{sourceId:source.sourceId,kind:source.kind})).body).toMatchObject({unknownAcceptance:true,generations:[{state:'unknown_acceptance',claims:[],financial:{dispatchState:'unknown_acceptance',settlementState:'estimated',settledCents:4}}]});expect(calls).toBe(1);
    }finally{release();await running;}
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

  it('releases a recovered reservation from an earlier business day before any external dispatch',async()=>{
    const {post}=await activatePurpose();
    const {source}=await selectedSource('Old reservation day','Reserved yesterday.');
    const request=await post('/crm/processing/request',command({source}));const generationId=(request.body as {result:{generationId:string}}).result.generationId;
    const reservationId=randomUUID();await fixture.db.query("INSERT INTO provider_reservations(workspace_id,id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens) VALUES($1,$2,'aws_bedrock.fixture','crm_extraction',$3,1,'2000-01-01','America/New_York',4,'fixture-model-v1',2000,4096)",[fixture.alpha.workspaceId,reservationId,generationId]);
    await fixture.db.query("INSERT INTO crm_extraction_financial_receipts(workspace_id,generation_id,reservation_id,job_id,fencing_token,dispatch_state,endpoint_id,model_version,access_grant_version,data_handling_version,purpose_revision,input_price_micros,output_price_micros) SELECT $1,$2,$3,j.id,1,'reserved',p.endpoint_id,p.model_version,p.access_grant_version,p.data_handling_version,p.revision,p.input_token_price_micros,p.output_token_price_micros FROM jobs j JOIN crm_extraction_purposes p ON p.workspace_id=j.workspace_id WHERE j.workspace_id=$1 AND j.payload->>'generationId'=$2::uuid::text LIMIT 1",[fixture.alpha.workspaceId,generationId,reservationId]);
    let calls=0;const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:null,claims:[]};}}}));
    await runOnce(fixture.db,{registry,owner:'crm-reservation-day',limit:20});
    expect(calls).toBe(0);expect((await post('/crm/processing/health/read',{sourceId:source.sourceId,kind:source.kind})).body).toMatchObject({generations:[{state:'unavailable',reason:'reservation_authority_changed',financial:{dispatchState:'released',settlementState:'released',settledCents:0}}]});
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

  it('discards an extraction after requester access is revoked during the external wait, with money still conserved',async()=>{
    const {post}=await activatePurpose();
    await fixture.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'admin','active') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='admin',status='active'",[fixture.alpha.workspaceId,fixture.beta.admin.userId]);
    const {source}=await selectedSource('Revoked processing access','Private exact text.');await post('/crm/processing/request',command({source}));
    let release!:()=>void,started!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{started();await wait;return {acceptance:'accepted',usage:{inputTokens:10,outputTokens:10},claims:[{kind:'need',interpretation:'Needs support',status:'stated',quote:'Private exact text.',locator:'text:0:19'}]};}}}));
    const worker=await fixture.database.appRuntimeSession();const running=runOnce(worker,{registry,owner:'crm-revoked-provider-wait',limit:20});await entered;
    try{await fixture.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[fixture.alpha.workspaceId,fixture.alpha.admin.userId]);}finally{release();await running;await fixture.db.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[fixture.alpha.workspaceId,fixture.alpha.admin.userId]);}
    expect((await post('/crm/processing/health/read',{kind:source.kind,sourceId:source.sourceId})).body).toMatchObject({generations:[{state:'stale',reason:'source_or_authority_changed',claims:[],financial:{dispatchState:'settled',settledCents:1}}]});
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });
  it('rejects a model quotation not present at its exact source locator without retaining the invented quote',async()=>{
    const {post}=await activatePurpose();
    const {source}=await selectedSource('Invalid model quotation','Real selected excerpt.');await post('/crm/processing/request',command({source}));
    const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:forward.mailEvidence,verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,adapter:{endpointId:'evaluation-adapter',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-purpose-grant-v1',dataHandlingVersion:'fixture-data-policy-v1',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>({acceptance:'accepted',usage:{inputTokens:10,outputTokens:10},claims:[{kind:'commitment',interpretation:'Invented promise',status:'stated',quote:'Invented promise',locator:'text:0:16'}]})}}));
    await runOnce(fixture.db,{registry,owner:'crm-invalid-quote',limit:20});
    const read=await post('/crm/processing/read',{source});expect(read.body).toMatchObject({state:'failed',reason:'invalid_quote',claims:[],financial:{settledCents:1}});expect(JSON.stringify(read.body)).not.toContain('Invented promise');
    await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  });

});
