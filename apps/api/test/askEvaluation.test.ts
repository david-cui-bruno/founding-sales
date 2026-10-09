import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { crmResolvedSourceSchema } from '@fss/contracts';
import { runEvaluation } from '../../../tools/ask-evaluation/runner.ts';
import { frozenCorpusSchema, frozenManifestSchema } from '../../../tools/ask-evaluation/contracts.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

it('measures a frozen development selected-note lexical baseline through authenticated public reads', async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const post = (path: string, body: unknown) => dispatch({method:'POST', path, body,
      query:new URLSearchParams(), headers:{authorization:`Bearer ${token}`}}, {
      session:fixture.db, auth:fixture.deps,
      supportedClientVersions:fixture.deps.config.supportedClientVersions, sendingEnabled:false,
    });
    const person = await post('/crm/people/create', {commandId:randomUUID(),
      clientVersion:CURRENT_CLIENT_VERSION, fullName:'Synthetic Development Person'});
    expect(person.status).toBe(200);
    const personId = (person.body as {result:{personId:string}}).result.personId;
    const text = 'Maintenance routing needs a clearer process.';
    const selection = {text,subtype:'pasted_text',label:'Synthetic evaluation note',
      direction:'unknown',participants:[],occurredAt:null,attachments:[]};
    const preview = await post('/crm/imports/preview',selection);
    expect(preview.status).toBe(200);
    const committed = await post('/crm/imports/commit', {commandId:randomUUID(),
      clientVersion:CURRENT_CLIENT_VERSION,...selection,personId,firmId:null,
      importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,
      parserVersion:'selected-v1'});
    expect(committed.status).toBe(200);
    const sourceId = (committed.body as {result:{sourceId:string}}).result.sourceId;
    const contentHash = createHash('sha256').update(text).digest('hex');
    const sourceRead = await post('/crm/processing/source/read', {
      workspaceId:fixture.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,
      contentHash,locator:`text:0:${text.length}`,
    });
    expect(sourceRead.status).toBe(200);
    const source = crmResolvedSourceSchema.parse(sourceRead.body).source;
    const fixtureDefinition = {id:'dev_corpus',fixtureVersion:'synthetic-v1',sources:[{
      id:'dev_note',kind:'selected_note',setupId:'synthetic_selected_note',originalSha256:contentHash,
      windows:[{id:'dev_window',source,textSha256:contentHash,chunkerVersion:'lexical-original-v1',ordinal:0}],
    }],cases:[{id:'dev_topic',category:'topic',actorFixtureId:'dev_actor',corpusId:'dev_corpus',
      request:{operation:'passages',scope:{sources:[{workspaceId:source.workspaceId,
        sourceId:source.sourceId,kind:source.kind,revision:source.revision,
        contentHash:source.contentHash,locator:null}]},query:'maintenance routing',limit:50},
      relevance:[{windowId:'dev_window',grade:2}],acceptableClaims:[],mustAbstain:false,
      exactExpected:null,labelVersion:'independent-v1',labelAuthoringState:'independent_before_candidate_outputs',
      lifecycleScenario:'none'}]};
    const development = frozenCorpusSchema.parse({...fixtureDefinition,corpusSha256:hash(fixtureDefinition)});
    const candidate = {embeddingId:'fake_embedding',embeddingVersion:'v1',dimensions:2,
      answerId:'fake_answer',answerVersion:'v1',vectorMetric:'cosine',fusion:'rrf',rrfConstant:60,
      k:10,textConfiguration:'simple'};
    const envelope = {version:'synthetic-orchestration-v1',criticalFailureCeiling:0,
      exactMismatchCeiling:0,canonicalCitationFailureCeiling:0,duplicatePublicationCeiling:0,
      maxCallsPerRun:5000,maxInputTokensPerRun:1000000,maxOutputTokensPerRun:100000,
      maxSpendCents:0,maxCaseWallTimeMs:10000,maxRunWallTimeMs:600000,
      maxWindowsPerCorpus:1000,maxScoredWindowsPerCorpus:50,maxSourcesPerCorpus:10};
    const manifest = frozenManifestSchema.parse({version:'ask-evaluation-v1',mode:'fake_only',
      corpusSha256:development.corpusSha256,splitSha256:hash(['dev_topic']),
      sourceManifestSha256:hash(development.sources),chunkerVersion:'lexical-original-v1',
      dedupUnit:'trim_whitespace_lowercase_en_us_text_group',
      lexicalRank:'first_matched_window_source_order_not_relevance',
      refWindowMappingSha256:hash(development.sources.flatMap(row=>row.windows)),
      baselineSourceCommit:'2e46128b46eebe451979c8e4fcab562fcd8ab109',candidate,envelope,
      configurationSha256:hash({candidate,envelope})});
    const report = await runEvaluation({phase:'development_baseline',manifest,development,
      publicReads:{read:async(actor,path,body)=>{expect(actor).toBe('dev_actor');return post(path,body);}}});
    expect(report.baselineMeasured).toBe(true);
    expect(report.caseResults).toHaveLength(1);
    expect(report.caseResults[0]).toMatchObject({caseId:'dev_topic',path:'lexical',
      recallAt10:1,precisionAt10:1,ndcgAt10:1,qualityScoringState:'scored',
      validCitations:1,invalidCitations:0,failures:[],
      usage:{outcome:'observed',calls:0,inputTokens:0,outputTokens:0,reservedCents:'0',observedCents:'0'}});
    expect(report.realVectorMeasured).toBe(false);
    expect(report.realModelMeasured).toBe(false);
    expect(report.activationAllowed).toBe(false);
  } finally { await fixture.stop(); }
});
