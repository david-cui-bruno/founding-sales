import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { migration0019EmailDrafts } from '../../src/main/db/migrations/0019EmailDrafts';
import { createDomainServices, type DomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain, type FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createEmailService } from '../../src/main/outreach/emailService';
import { EmailRepository } from '../../src/main/outreach/emailRepository';
import type { FrozenEmail, GroundedDraftContext, OutreachProviders, EmailSendResult } from '../../src/main/outreach/providers/providerTypes';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { seedProspect, insertOpenCycleWithAction, DOMAIN_TIMESTAMP } from '../fixtures/domainRows';

const now = () => '2026-09-08T15:00:00.000Z';
describe('durable explicit email using real encrypted SQLite', () => {
  let temp:TempDatabase, db:AppDatabase, domain:FounderSalesDomain;
  let service:ReturnType<typeof createEmailService>;
  let sent:FrozenEmail[], contexts:GroundedDraftContext[];
  let outcome:EmailSendResult;
  let services:DomainServices;
  let providers:OutreachProviders;
  let workspaceKey:ReturnType<typeof createTestWorkspaceKey>;
  let sendHook:()=>void;
  let domainDelay:Promise<void>|null;
  let domainEntered:()=>void;
  let databaseDelay:Promise<void>|null;
  let databaseEntered:()=>void;
  let setup:Awaited<ReturnType<OutreachProviders['status']>>;
  let prepareHook:()=>void;
  const personId='email-person', contactMethodId='email-address';
  beforeEach(async () => {
    temp=createTempDatabase(); const key=createTestWorkspaceKey();workspaceKey=key;
    db=openDatabase({path:temp.path,key});
    await migrateToLatest(db,{backupDirectory:`${temp.path}.backups`,workspaceKey:key});
    if (!db.raw.prepare("SELECT name FROM sqlite_master WHERE name='email_drafts'").get()) await migration0019EmailDrafts.up(db.kysely);
    const clock={now}; const ids={next:randomUUID};
    services=createDomainServices({database:db,clock,ids});
    services.unitOfWork.immediate(()=>services.cadences.installBuiltins());
    const prospect=seedProspect(db.raw,'email');
    insertOpenCycleWithAction({database:db.raw,prefix:'email',prospect});
    db.raw.prepare(`INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,is_primary,created_at,updated_at)
      VALUES (?,?,'email','owner@example.com','valid','direct',1,?,?)`).run(contactMethodId,personId,DOMAIN_TIMESTAMP,DOMAIN_TIMESTAMP);
    domain=createFounderSalesDomain({database:db,services,clock,ids});
    sent=[];contexts=[];prepareHook=()=>undefined;sendHook=()=>undefined;domainDelay=null;domainEntered=()=>undefined;databaseDelay=null;databaseEntered=()=>undefined;
    outcome={status:'accepted',messageId:'gmail-1',threadId:null};
    setup={model:'unconfigured',modelName:'test-model',gmail:'ready',accountEmail:'founder@example.com',senderName:'Test Founder',postalAddress:'1 Test Street, Providence RI'};
    providers={
      status:async()=>({...setup}), configure:async()=>({...setup}),connectGmail:async()=>({...setup}),disconnectGmail:async()=>({...setup}),dispose:()=>undefined,
      generate:async context=>{contexts.push(context);return {subject:'Your local portfolio',body:'Would a brief conversation be useful?',evidenceIds:[],provider:'openai',model:'test-model',responseId:'response-1'};},
      prepare:async()=>{prepareHook();return {accountEmail:setup.accountEmail!,sendOnce:async email=>{sent.push(email);sendHook();return outcome;}};},
    };
    service=createEmailService({databaseGate:{withDatabase:async fn=>{databaseEntered();await databaseDelay;return fn(db);},withDomain:async fn=>{domainEntered();await domainDelay;return fn(domain);}},providers,now,id:randomUUID});
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
  it('recovers a committed interrupted intent from disk as unknown without dispatch',async()=>{
    const draft=await readyDraft();const commandId=randomUUID();
    db.raw.transaction(()=>new EmailRepository(db).reserve({
      email:{commandId,from:setup.accountEmail!,to:draft.recipient,subject:draft.subject,body:`${draft.body}\n\n${draft.footer}`},
      draftId:draft.id,draftRevision:draft.revision,personId,salesCycleId:'email-cycle',prospectId:'email-prospect',
      cycleVersion:1,action:null,policyId:'pre-crash-policy',createdAt:now(),
    })).immediate();
    service.dispose();closeDatabase(db);db=openDatabase({path:temp.path,key:workspaceKey});
    services=createDomainServices({database:db,clock:{now},ids:{next:randomUUID}});
    domain=createFounderSalesDomain({database:db,services,clock:{now},ids:{next:randomUUID}});
    service=createEmailService({databaseGate:{withDatabase:async fn=>fn(db),withDomain:async fn=>fn(domain)},providers,now,id:randomUUID});
    const recovered=await service.openDraft({personId,contactMethodId});
    expect(recovered.status).toBe('unknown');
    expect((await service.sendDraft({draftId:draft.id,expectedRevision:recovered.revision,commandId:randomUUID()})).status).toBe('unknown');
    expect(sent).toHaveLength(0);
    expect(db.raw.prepare('SELECT status FROM email_send_results WHERE command_id=?').get(commandId)).toEqual({status:'unknown'});
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM email_send_intents').get()).toEqual({n:1});
  });
  it('rechecks person-wide suppression after token preparation',async()=>{
    const draft=await readyDraft();prepareHook=()=>domain.logCallOutcome({personId,salesCycleId:'email-cycle',outcome:'opted_out',callbackAt:null,occurredAt:now()});
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
  it('explicit Send performs the guarded readiness transition for a real Unreviewed cycle',async()=>{
    const prospect=seedProspect(db.raw,'new');
    db.raw.prepare("UPDATE prospects SET qualification_state='unreviewed' WHERE id=?").run(prospect.prospectId);
    const cycle=services.lifecycle.createUnreviewedCycle({personId:prospect.personId,prospectId:prospect.prospectId,entrySourceEventId:prospect.sourceEventId,effectiveAt:now()});
    db.raw.prepare(`INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,is_primary,created_at,updated_at)
      VALUES ('new-email',?,'email','new@example.com','valid','direct',1,?,?)`).run(prospect.personId,now(),now());
    let draft=await service.openDraft({personId:prospect.personId,contactMethodId:'new-email'});
    expect(db.raw.prepare('SELECT stage FROM sales_cycles WHERE id=?').get(cycle.id)).toEqual({stage:'unreviewed'});
    draft=await service.saveDraft({draftId:draft.id,expectedRevision:draft.revision,subject:'Hello',body:'Reviewed'});
    expect((await service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()})).status).toBe('sent');
    expect(db.raw.prepare('SELECT stage FROM sales_cycles WHERE id=?').get(cycle.id)).toEqual({stage:'contacted'});
  });
  it('accepted email completes only the real matching email cadence action',async()=>{
    const prospect=seedProspect(db.raw,'cold');
    db.raw.prepare("UPDATE prospects SET qualification_state='unreviewed',segment='cold' WHERE id=?").run(prospect.prospectId);
    const cycle=services.lifecycle.createUnreviewedCycle({personId:prospect.personId,prospectId:prospect.prospectId,entrySourceEventId:prospect.sourceEventId,effectiveAt:now()});
    services.lifecycle.reviewToReady({cycleId:cycle.id,expectedCycleVersion:cycle.version,expectedProspectVersion:1,effectiveAt:now()});
    let action:{id:string;action_type:string}|undefined;
    for(let count=0;count<20;count++){
      action=db.raw.prepare('SELECT a.id,a.action_type FROM sales_cycles c JOIN next_actions a ON a.id=c.current_next_action_id WHERE c.id=?').get(cycle.id) as {id:string;action_type:string};
      if(action.action_type==='email')break;
      domain.completePrimaryAction({salesCycleId:cycle.id,actionId:action.id,outcome:action.action_type==='call'?'no_answer':action.action_type==='voicemail'?'voicemail_left':'accepted',activityId:null});
    }
    expect(action?.action_type).toBe('email');
    db.raw.prepare(`INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,is_primary,created_at,updated_at)
      VALUES ('cold-email',?,'email','cold@example.com','valid','direct',1,?,?)`).run(prospect.personId,now(),now());
    let draft=await service.openDraft({personId:prospect.personId,contactMethodId:'cold-email'});
    draft=await service.saveDraft({draftId:draft.id,expectedRevision:draft.revision,subject:'Hello',body:'Reviewed'});
    expect((await service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()})).status).toBe('sent');
    expect(db.raw.prepare('SELECT status FROM next_actions WHERE id=?').get(action!.id)).toEqual({status:'completed'});
    expect(db.raw.prepare('SELECT stage FROM sales_cycles WHERE id=?').get(cycle.id)).toEqual({stage:'contacted'});
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM next_actions WHERE sales_cycle_id=? AND status='pending'").get(cycle.id)).toEqual({n:1});
  });
  it('lock during preparation prevents dispatch and remains closed until unlock',async()=>{
    const draft=await readyDraft();prepareHook=()=>service.invalidate(true);
    await expect(service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()})).rejects.toThrow();
    expect(sent).toHaveLength(0);
    expect(()=>service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()})).toThrow();
  });
  it('late opt-out preserves accepted evidence without promoting the cycle',async()=>{
    const draft=await readyDraft();sendHook=()=>domain.logCallOutcome({personId,salesCycleId:'email-cycle',outcome:'opted_out',callbackAt:null,occurredAt:now()});
    expect((await service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()})).status).toBe('sent');
    expect(db.raw.prepare('SELECT stage FROM sales_cycles WHERE id=?').get('email-cycle')).toEqual({stage:'lost_nurture'});
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM activities WHERE adapter='fss_gmail_v1'").get()).toEqual({n:1});
  });
  it('immutable send ledger rejects rewriting the frozen target or result',async()=>{
    const draft=await readyDraft();await service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()});
    expect(()=>db.raw.prepare("UPDATE email_send_intents SET reservation_json='{}'").run()).toThrow('immutable');
    expect(()=>db.raw.prepare('DELETE FROM email_send_results').run()).toThrow('immutable');
  });
  it('does not upload context if lock happens while waiting for domain context',async()=>{
    const draft=await readyDraft();setup.model='ready';
    let release!:()=>void;let entered!:()=>void;
    const reached=new Promise<void>(resolve=>{entered=resolve;});
    domainDelay=new Promise<void>(resolve=>{release=resolve;});domainEntered=entered;
    const generating=service.generateDraft({draftId:draft.id,expectedRevision:draft.revision});
    await reached;service.invalidate(true);release();
    await generating.catch(():undefined=>undefined);
    expect(contexts).toHaveLength(0);
  });
  it('does not save an old request after its workspace is locked',async()=>{
    const draft=await readyDraft();let release!:()=>void;let entered!:()=>void;
    const reached=new Promise<void>(resolve=>{entered=resolve;});
    databaseDelay=new Promise<void>(resolve=>{release=resolve;});databaseEntered=entered;
    const saving=service.saveDraft({draftId:draft.id,expectedRevision:draft.revision,subject:'Late',body:'Late edit'});
    await reached;service.invalidate(true);release();
    await expect(saving).rejects.toThrow('email_workspace');
    expect(db.raw.prepare('SELECT subject FROM email_drafts WHERE id=?').get(draft.id)).toEqual({subject:'Hello'});
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
