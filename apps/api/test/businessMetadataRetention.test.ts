import { retentionBatchHandler } from '@fss/domain/retention/handler.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { SuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { observeBusinessMetadata } from '@fss/domain/business/acquisition.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm, seedContact } from './support/crmSeed.ts';
let fixture: AuthFixture;
let token: string;
const journal = recordingSuppressionJournal();
let activeJournal: SuppressionJournal = journal;
const command = (fields: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
const post = (path: string, body: unknown) => dispatch({ method: 'POST', path, query: new URLSearchParams(),
  headers: { authorization: `Bearer ${token}` }, body }, { auth: fixture.deps, session: fixture.db,
  supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false, suppressionJournal: activeJournal });
beforeEach(async () => { fixture = await createAuthFixture(); token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken; });
afterEach(async () => { await fixture.stop(); });
it('previews and removes whole metadata copies involving an exact target address while retaining unrelated unknown business contacts', async () => {
  const firmId = await seedFirm(fixture, { name: 'Metadata target firm', regionCode: 'RI', postalCode: '02903', assignedUserId: fixture.alpha.admin.userId });
  const contactId = await seedContact(fixture, { firmId, fullName: 'Metadata target person' });
  expect((await post('/contacts/routes/add', command({ firmId, contactId, routeKind: 'email', value: 'target@firm.example', source: 'salesperson', technicalValidation: 'passed', associationConfidence: 0.95 }))).status).toBe(200);
  const mailboxId = (await fixture.db.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'owner@firm.example','metadata-account','connected') RETURNING id", [fixture.alpha.workspaceId,fixture.alpha.admin.userId])).rows[0]?.id;
  if (mailboxId === undefined) throw new Error('Mailbox fixture unavailable');
  const policy = (await post('/crm/business/policy/read', { mailboxId })).body as { generation:number; accountBinding:string; metadataReviewDisclosure: {version:string;sha256:string} };
  expect((await post('/crm/business/policy/save', command({ mailboxId, expectedGeneration: policy.generation, expectedAccountBinding: policy.accountBinding, expectedRevision: 0, enabled: false, disclosure: policy.metadataReviewDisclosure }))).status).toBe(200);
  const worker = repositoryContext(workspaceScope(fixture.alpha.workspaceId,{kind:'system',component:'worker'}),fixture.db);
  const observe = (providerThreadId: string, participants: string[], subject: string) => withTransaction(fixture.db,()=>observeBusinessMetadata(worker,{mailboxId,providerAccountId:'metadata-account',generation:1,expectedPolicyRevision:1,providerThreadId,providerMessageId:providerThreadId,participants,subject,latestProviderAt:'2026-10-09T12:00:00.000Z',category:'uncertain',reason:'unclassified_metadata',classifierVersion:'metadata-v1'}));
  expect(await observe('mixed-thread',['target@firm.example','unknown@other.example'],'Sensitive mixed conversation')).toMatchObject({ok:true});
  expect(await observe('unrelated-thread',['unknown@other.example'],'Unrelated unknown correspondent')).toMatchObject({ok:true});
  const preview = await post('/retention/deletions/preview',command({targetKind:'contact',firmId,contactId}));
  expect(preview.status).toBe(200);
  const shown = (preview.body as {result:{requestId:string;previewHash:string;redacts:Record<string,number>}}).result;
  expect(shown.redacts['crm_business_conversations']).toBe(1);
  let releaseJournal!: () => void;
  let enteredJournal!: () => void;
  const journalWait = new Promise<void>(resolve => { releaseJournal=resolve; });
  const entered = new Promise<void>(resolve => { enteredJournal=resolve; });
  let first=true;
  activeJournal={ append: async record => {
    if (first) { first=false; enteredJournal(); await journalWait; }
    await journal.append(record);
  } };
  const observerSession=await fixture.database.appRuntimeSession();
  const monitor=await fixture.database.appRuntimeSession();
  const observerPid=(await observerSession.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  const pendingCommit=post('/retention/deletions/commit',command({requestId:shown.requestId,previewHash:shown.previewHash}));
  await entered;
  let observationSettled=false;
  const duringDeletion=withTransaction(observerSession,()=>observeBusinessMetadata(
    repositoryContext(workspaceScope(fixture.alpha.workspaceId,{kind:'system',component:'worker'}),observerSession),
    {mailboxId,providerAccountId:'metadata-account',generation:1,expectedPolicyRevision:1,
      providerThreadId:'mid-deletion-thread',providerMessageId:'mid-deletion-message',
      participants:['target@firm.example','unknown@other.example'],subject:'Racing deleted metadata',
      latestProviderAt:'2026-10-09T12:00:00.000Z',category:'uncertain',reason:'unclassified_metadata',classifierVersion:'metadata-v1'}
  )).then(result=>{ observationSettled=true; return result; });
  let blocked=false;
  try {
    for (let attempt=0;attempt<100 && !observationSettled;attempt++) {
      blocked=(await monitor.query<{blocked:boolean}>(
        'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[observerPid])).rows[0]?.blocked ?? false;
      if (blocked) break;
      await delay(10);
    }
  } finally { releaseJournal(); }
  const committed=await pendingCommit;
  activeJournal=journal;
  expect(blocked).toBe(true);
  expect(await duringDeletion).toMatchObject({ok:false,reason:'metadata_deleted'});

  expect(committed.status).toBe(200);
  expect(committed.body).toMatchObject({result:{redacted:{crm_business_conversations:1}}});
  const review = await post('/crm/business/review/read',{mailboxId});
  expect(review.status).toBe(200);
  expect(review.body).toMatchObject({conversations:[{subject:'Unrelated unknown correspondent'}]});
  expect(JSON.stringify(review.body)).not.toContain('Sensitive mixed conversation');
  expect(await observe('mixed-thread',['target@firm.example'],'Deleted replay')).toMatchObject({ok:false,reason:'metadata_deleted'});
  expect(await observe('new-thread-after-deletion',['target@firm.example','unknown@other.example'],'New copy of deleted correspondent')).toMatchObject({ok:false,reason:'metadata_deleted'});
});

it('expires old metadata through the registered retention handler and refuses later replay of its copied identity', async () => {
  const isolated=await createAuthFixture();
  try {
    const bearer=(await issueSessionFor(isolated,isolated.alpha,isolated.alpha.admin)).accessToken;
    const api=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),
      headers:{authorization:`Bearer ${bearer}`},body},{auth:isolated.deps,session:isolated.db,
      supportedClientVersions:isolated.deps.config.supportedClientVersions,sendingEnabled:false});
    const mailboxId=(await isolated.db.query<{id:string}>(
      "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'expiry@firm.example','expiry-account','connected') RETURNING id",
      [isolated.alpha.workspaceId,isolated.alpha.admin.userId])).rows[0]?.id;
    if (mailboxId===undefined) throw new Error('Mailbox fixture unavailable');
    const policy=(await api('/crm/business/policy/read',{mailboxId})).body as {generation:number;accountBinding:string;metadataReviewDisclosure:{version:string;sha256:string}};
    expect((await api('/crm/business/policy/save',command({mailboxId,expectedGeneration:policy.generation,
      expectedAccountBinding:policy.accountBinding,expectedRevision:0,enabled:false,disclosure:policy.metadataReviewDisclosure}))).status).toBe(200);
    const scope=workspaceScope(isolated.alpha.workspaceId,{kind:'system',component:'worker'});
    const context=repositoryContext(scope,isolated.db);
    const observation={mailboxId,providerAccountId:'expiry-account',generation:1,expectedPolicyRevision:1,
      providerThreadId:'expired-thread',providerMessageId:'expired-message',participants:['old@unknown.example'],
      subject:'Expired review subject',latestProviderAt:new Date().toISOString(),category:'uncertain' as const,
      reason:'unclassified_metadata',classifierVersion:'metadata-v1'};
    expect(await withTransaction(isolated.db,()=>observeBusinessMetadata(context,observation))).toMatchObject({ok:true});
    // Age fixture metadata beyond its bounded review horizon without sleeping ninety days.
    await isolated.db.query("UPDATE crm_business_conversations SET latest_provider_at=clock_timestamp()-interval '91 days' WHERE workspace_id=$1",[isolated.alpha.workspaceId]);
    const now=new Date().toISOString();
    await withTransaction(isolated.db,()=>retentionBatchHandler().handle({session:isolated.db,scope,job:{
      id:randomUUID(),workspaceId:isolated.alpha.workspaceId,kind:'retention.batch',idempotencyKey:'retention-expiry-fixture',
      payload:{dataKind:'unmatched_gmail_metadata',period:now.slice(0,10)},attempt:1,maxAttempts:6,
      fencingToken:'1',leaseOwner:'retention-fixture',leaseExpiresAt:now,
    }}));
    expect(await withTransaction(isolated.db,()=>observeBusinessMetadata(context,{...observation,subject:'Attempted expired replay'})))
      .toMatchObject({ok:false,reason:'metadata_deleted'});
    expect((await api('/crm/business/review/read',{mailboxId})).body).toMatchObject({conversations:[]});
  } finally { await isolated.stop(); }
});
it('includes an explicitly supported shared firm endpoint in deletion even when it is not an outreach route', async () => {
  const firmId=await seedFirm(fixture,{name:'Shared endpoint target',regionCode:'RI',postalCode:'02903',assignedUserId:fixture.alpha.admin.userId});
  const selected=await post('/crm/firm-sources/add',command({firmId,sourceKey:'shared-metadata-evidence',excerpt:'Use office@shared.example for our office.',occurredAt:'2026-10-01T14:00:00.000Z'}));
  expect(selected.status).toBe(200);
  const page=(await post('/crm/firm-sources/read',{firmId})).body as {sources:{sourceId:string;revision:number;contentHash:string}[]};
  const source=page.sources[0];
  if (source===undefined) throw new Error('Source fixture unavailable');
  expect((await post('/crm/endpoints/claim',command({kind:'email',value:'office@shared.example',personId:null,firmId,shared:true,
    status:'current',startDate:null,endDate:null,evidence:{sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash}}))).status).toBe(200);
  const mailboxId=(await fixture.db.query<{id:string}>(
    "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'shared-owner@firm.example','shared-account','connected') RETURNING id",
    [fixture.alpha.workspaceId,fixture.alpha.admin.userId])).rows[0]?.id;
  if (mailboxId===undefined) throw new Error('Mailbox fixture unavailable');
  const disclosure=(await post('/crm/business/policy/read',{mailboxId})).body as {generation:number;accountBinding:string;metadataReviewDisclosure:{version:string;sha256:string}};
  expect((await post('/crm/business/policy/save',command({mailboxId,expectedGeneration:disclosure.generation,
    expectedAccountBinding:disclosure.accountBinding,expectedRevision:0,enabled:false,disclosure:disclosure.metadataReviewDisclosure}))).status).toBe(200);
  const policy=(await post('/crm/business/policy/read',{mailboxId})).body as {mailboxId:string;generation:number;revision:number};
  const worker=repositoryContext(workspaceScope(fixture.alpha.workspaceId,{kind:'system',component:'worker'}),fixture.db);
  const observation={mailboxId:policy.mailboxId,providerAccountId:'shared-account',generation:policy.generation,expectedPolicyRevision:policy.revision,
    providerThreadId:'shared-endpoint-thread',providerMessageId:'shared-endpoint-message',participants:['office@shared.example'],
    subject:'Private office correspondence',latestProviderAt:new Date().toISOString(),category:'uncertain' as const,reason:'unclassified_metadata',classifierVersion:'metadata-v1'};
  expect(await withTransaction(fixture.db,()=>observeBusinessMetadata(worker,observation))).toMatchObject({ok:true});
  const preview=await post('/retention/deletions/preview',command({targetKind:'firm',firmId}));
  expect(preview.status).toBe(200);
  const shown=(preview.body as {result:{requestId:string;previewHash:string;redacts:Record<string,number>;tombstoneHandles:string[]}}).result;
  expect(shown.redacts['crm_business_conversations']).toBe(1);
  expect(shown.tombstoneHandles).toContain('office@shared.example');
  expect((await post('/retention/deletions/commit',command({requestId:shown.requestId,previewHash:shown.previewHash}))).status).toBe(200);
  expect(await withTransaction(fixture.db,()=>observeBusinessMetadata(worker,{...observation,providerThreadId:'new-shared-deleted-thread',providerMessageId:'new-shared-deleted-message'})))
    .toMatchObject({ok:false,reason:'metadata_deleted'});
  expect(JSON.stringify((await post('/crm/business/review/read',{mailboxId:policy.mailboxId})).body)).not.toContain('Private office correspondence');
});
