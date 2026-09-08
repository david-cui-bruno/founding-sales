import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { migration0019EmailDrafts } from '../../src/main/db/migrations/0019EmailDrafts';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain, type FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createEmailService } from '../../src/main/outreach/emailService';
import type { FrozenEmail, GroundedDraftContext, OutreachProviders, EmailSendResult } from '../../src/main/outreach/providers/providerTypes';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { seedProspect, insertOpenCycleWithAction, DOMAIN_TIMESTAMP } from '../fixtures/domainRows';

const now = () => '2026-09-08T15:00:00.000Z';
describe('durable explicit email using real encrypted SQLite', () => {
  let temp:TempDatabase, db:AppDatabase, domain:FounderSalesDomain;
  let service:ReturnType<typeof createEmailService>;
  let sent:FrozenEmail[], contexts:GroundedDraftContext[];
  let outcome:EmailSendResult;
  let setup:Awaited<ReturnType<OutreachProviders['status']>>;
  let prepareHook:()=>void;
  const personId='email-person', contactMethodId='email-address';
  beforeEach(async () => {
    temp=createTempDatabase(); const key=createTestWorkspaceKey();
    db=openDatabase({path:temp.path,key});
    await migrateToLatest(db,{backupDirectory:`${temp.path}.backups`,workspaceKey:key});
    if (!db.raw.prepare("SELECT name FROM sqlite_master WHERE name='email_drafts'").get()) await migration0019EmailDrafts.up(db.kysely);
    const clock={now}; const ids={next:randomUUID};
    const services=createDomainServices({database:db,clock,ids});
    services.unitOfWork.immediate(()=>services.cadences.installBuiltins());
    const prospect=seedProspect(db.raw,'email');
    insertOpenCycleWithAction({database:db.raw,prefix:'email',prospect});
    db.raw.prepare(`INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,is_primary,created_at,updated_at)
      VALUES (?,?,'email','owner@example.com','valid','direct',1,?,?)`).run(contactMethodId,personId,DOMAIN_TIMESTAMP,DOMAIN_TIMESTAMP);
    domain=createFounderSalesDomain({database:db,services,clock,ids});
    sent=[];contexts=[];prepareHook=()=>undefined;
    outcome={status:'accepted',messageId:'gmail-1',threadId:null};
    setup={model:'unconfigured',modelName:'test-model',gmail:'ready',accountEmail:'founder@example.com',senderName:'Test Founder',postalAddress:'1 Test Street, Providence RI'};
    const providers:OutreachProviders={
      status:async()=>({...setup}), configure:async()=>({...setup}),connectGmail:async()=>({...setup}),disconnectGmail:async()=>({...setup}),dispose:()=>undefined,
      generate:async context=>{contexts.push(context);return {subject:'Your local portfolio',body:'Would a brief conversation be useful?',evidenceIds:[],provider:'openai',model:'test-model',responseId:'response-1'};},
      prepare:async()=>{prepareHook();return {accountEmail:setup.accountEmail!,sendOnce:async email=>{sent.push(email);return outcome;}};},
    };
    service=createEmailService({databaseGate:{withDatabase:async fn=>fn(db),withDomain:async fn=>fn(domain)},providers,now,id:randomUUID});
  });
  afterEach(()=>{service?.dispose();if(db)closeDatabase(db);temp?.cleanup();});
  async function readyDraft() {
    const draft=await service.openDraft({personId,contactMethodId});
    return service.saveDraft({draftId:draft.id,expectedRevision:draft.revision,subject:'Hello',body:'A personally reviewed email.'});
  }
  it('reopens persisted edits and refuses stale writes without moving stage',async()=>{
    const edited=await readyDraft();
    expect((await service.openDraft({personId,contactMethodId})).body).toBe(edited.body);
    await expect(service.saveDraft({draftId:edited.id,expectedRevision:1,subject:'stale',body:'stale'})).rejects.toThrow();
    expect(db.raw.prepare('SELECT stage FROM sales_cycles WHERE id=?').get('email-cycle')).toEqual({stage:'ready'});
    expect(sent).toHaveLength(0);
  });
  it('sends only explicitly, freezes footer/target, records acceptance exactly once',async()=>{
    const draft=await readyDraft();const commandId=randomUUID();
    const request={draftId:draft.id,expectedRevision:draft.revision,commandId};
    expect((await service.sendDraft(request)).status).toBe('sent');
    expect((await service.sendDraft(request)).status).toBe('sent');
    expect(sent).toHaveLength(1);expect(sent[0].to).toBe('owner@example.com');
    expect(sent[0].body).toContain(setup.postalAddress);expect(sent[0].body).toContain('stop');
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM activities WHERE adapter='fss_gmail_v1'").get()).toEqual({n:1});
  });
  it('uncertainty blocks resend even with a new command and reopening',async()=>{
    const draft=await readyDraft();outcome={status:'unknown',reasonCode:'network_uncertain'};
    const uncertain=await service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()});
    expect(uncertain.status).toBe('unknown');
    const reopened=await service.openDraft({personId,contactMethodId});
    expect((await service.sendDraft({draftId:reopened.id,expectedRevision:reopened.revision,commandId:randomUUID()})).status).toBe('unknown');
    expect(sent).toHaveLength(1);
  });
  it('rechecks person-wide suppression after token preparation',async()=>{
    const draft=await readyDraft();prepareHook=()=>db.raw.prepare('UPDATE persons SET opted_out=1 WHERE id=?').run(personId);
    await expect(service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()})).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
  it('rejects changed recipient snapshot',async()=>{
    const draft=await readyDraft();
    db.raw.prepare('UPDATE person_contact_methods SET normalized_value=? WHERE id=?').run('changed@example.com',contactMethodId);
    await expect(service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()})).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
  it('rejects sender or footer changes made after the reviewed preview',async()=>{
    const draft=await readyDraft();setup.postalAddress='Different office';
    await expect(service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()})).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
  it('rejects sender account changes made after draft opened',async()=>{
    const draft=await readyDraft();setup.accountEmail='other@example.com';
    await expect(service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()})).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
  it('generates once only for pristine drafts and excludes private note prose',async()=>{
    domain.addLeadNote({personId,salesCycleId:'email-cycle',text:'SECRET PRIVATE NOTE'});
    setup.model='ready'; const draft=await service.openDraft({personId,contactMethodId});
    expect(draft.generation).toBe('model');expect(contexts).toHaveLength(1);
    expect(JSON.stringify(contexts)).not.toContain('SECRET PRIVATE NOTE');
    const edited=await service.saveDraft({draftId:draft.id,expectedRevision:draft.revision,subject:'Mine',body:'Keep my edits'});
    expect((await service.openDraft({personId,contactMethodId})).body).toBe(edited.body);
    expect(contexts).toHaveLength(1);expect(sent).toHaveLength(0);
  });
});
