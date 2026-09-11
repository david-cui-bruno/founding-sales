import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { migration0019EmailDrafts } from '../../src/main/db/migrations/0019EmailDrafts';
import { createDomainServices, type DomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain, type FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createEmailService } from '../../src/main/outreach/emailService';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { companyDraftFacts } from '../../src/main/outreach/companyDraftContext';
import { EmailRepository } from '../../src/main/outreach/emailRepository';
import type { FrozenEmail, GroundedDraftContext, OutreachProviders, EmailSendResult } from '../../src/main/outreach/providers/providerTypes';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { seedProspect, insertOpenCycleWithAction, DOMAIN_TIMESTAMP } from '../fixtures/domainRows';

import { contactSnapshot } from '../../src/main/communications/contactSnapshot';
import { assertLocalEmailAuthority } from '../../src/main/delegation/executionRouter';

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
  it.each([false,true])('keeps the 40-fact prompt bounded with crowded person facts and company context=%s',async linked=>{
    for(let index=0;index<45;index++){
      const propertyId=`crowded-${String(index).padStart(2,'0')}`;
      db.raw.prepare(`INSERT INTO properties(id,address_line_1,locality,region,country_code,created_at,updated_at)
        VALUES(?,?,'Providence','RI','US',?,?)`).run(propertyId,`${index+1} Fictional Street`,now(),now());
      db.raw.prepare(`INSERT INTO prospect_properties(prospect_id,property_id,relationship,created_at)
        VALUES('email-prospect',?,'property_manager',?)`).run(propertyId,now());
    }
    const legacy=domain.getLeadDetail({personId}).portfolio!.facts;
    expect(legacy.length).toBeGreaterThanOrEqual(45);
    const accounts=new AccountRepository({database:db,clock:{now},ids:{next:randomUUID},
      sourcePolicy:{attest:source=>source.url==='https://example.invalid/company'}});
    if(linked){
      const account=accounts.create({commandId:randomUUID(),name:'Fictional Company',domain:null});
      const sourceId=randomUUID();
      accounts.admitEvidence({commandId:randomUUID(),accountId:account.id,expectedVersion:1,
        sources:[{id:sourceId,url:'https://example.invalid/company',fetchedAt:now(),sha256:'a'.repeat(64),excerpt:'Fictional company evidence',permitted:true}],
        claims:[{key:'portfolio',kind:'fact',value:{count:240,scope:'managed',measure:'units'},evidenceIds:[sourceId]},
          {key:'maintenance_workflow',kind:'fact',value:'Central dispatch',evidenceIds:[sourceId]}],routes:[]});
      accounts.admitLinks({commandId:randomUUID(),accountId:account.id,expectedVersion:2,links:[{
        id:randomUUID(),kind:'person_role',personId,role:'Property manager',relationship:'Listed employment',
        authority:'unconfirmed',authorityEvidenceIds:[],evidenceIds:[sourceId],validFrom:now(),validTo:null}]});
    }
    const company=companyDraftFacts(accounts.readDraftCompanyDetail(personId,now()));
    expect(company).toHaveLength(linked?2:0);
    setup.model='ready';
    const draft=await service.openDraft({personId,contactMethodId});
    expect(draft.generation).toBe('model');
    expect(contexts).toHaveLength(1);
    expect(contexts[0].facts).toHaveLength(40);
    expect(contexts[0].facts).toEqual([...legacy.slice(0,40-company.length),...company]);
    expect(sent).toEqual([]);
  });
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
  it.each(['recipient','metadata'])('explicit reopen creates a fresh target after %s changes and preserves old edits',async change=>{
    const draft=await readyDraft();
    if(change==='recipient')db.raw.prepare('UPDATE person_contact_methods SET normalized_value=? WHERE id=?').run('new-owner@example.com',contactMethodId);
    else db.raw.prepare('UPDATE person_contact_methods SET updated_at=? WHERE id=?').run('2026-09-08T15:01:00.000Z',contactMethodId);
    const fresh=await service.openDraft({personId,contactMethodId});
    expect(fresh.id).not.toBe(draft.id);expect(fresh.body).toBe('');
    expect(fresh.recipient).toBe(change==='recipient'?'new-owner@example.com':draft.recipient);
    expect(db.raw.prepare('SELECT body,recipient,superseded_at AS supersededAt FROM email_drafts WHERE id=?').get(draft.id))
      .toEqual({body:draft.body,recipient:draft.recipient,supersededAt:now()});
    await expect(service.saveDraft({draftId:draft.id,expectedRevision:draft.revision,subject:'stale',body:'stale'})).rejects.toThrow();
    const edited=await service.saveDraft({draftId:fresh.id,expectedRevision:fresh.revision,subject:'Current review',body:'New reviewed email'});
    expect((await service.sendDraft({draftId:edited.id,expectedRevision:edited.revision,commandId:randomUUID()})).status).toBe('sent');
    expect(sent).toHaveLength(1);expect(sent[0].to).toBe(fresh.recipient);
  });
  it('a changed contact cannot bypass an unknown send by reopening',async()=>{
    const draft=await readyDraft();outcome={status:'unknown',reasonCode:'network_uncertain'};
    await service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()});
    db.raw.prepare('UPDATE person_contact_methods SET normalized_value=? WHERE id=?').run('changed@example.com',contactMethodId);
    const reopened=await service.openDraft({personId,contactMethodId});
    expect(reopened.id).toBe(draft.id);expect(reopened.status).toBe('unknown');
    expect(sent).toHaveLength(1);expect(db.raw.prepare('SELECT COUNT(*) AS n FROM email_drafts').get()).toEqual({n:1});
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

  // Task7 source-only additions. Ownership is not final Send authorization.
  function authorityService(expectedWorkspaceId?: string) {
    service.dispose();
    service=createEmailService({databaseGate:{withDatabase:async fn=>{databaseEntered();await databaseDelay;return fn(db);},
      withDomain:async fn=>{domainEntered();await domainDelay;return fn(domain);}},providers,expectedWorkspaceId,now,id:randomUUID});
    return service;
  }
  function associate(id:string, route=false) {
    db.raw.prepare('INSERT INTO pm_accounts(id,name,version,created_at,updated_at) VALUES (?,?,1,?,?)').run(id,'Fictional ownership fixture',now(),now());
    if(route) db.raw.prepare(`INSERT INTO pm_account_routes(id,account_id,version,person_id,channel,value,purpose,verification,admitted_at)
      VALUES (?,?,1,NULL,'email','OWNER@EXAMPLE.COM','unknown','unverified',?)`).run(`${id}-route`,id,now());
    else db.raw.prepare(`INSERT INTO pm_account_links(id,account_id,kind,person_id,relationship,role,authority,valid_from,admitted_at)
      VALUES (?,?,'person_role',?,'fixture relationship','manager','unconfirmed',?,?)`).run(`${id}-link`,id,personId,now(),now());
  }
  function localOwner(id:string, workspace='fictional-workspace', owner='local', state='local') {
    db.raw.prepare(`INSERT INTO delegated_authorities(account_id,workspace_id,owner,generation,state,aggregate_version,updated_at)
      VALUES (?,?,?,0,?,0,?)`).run(id,workspace,owner,state,now());
  }
  function readBytes() {
    const tables=['email_drafts','email_send_intents','email_send_results','delegated_authorities','delegated_commands'];
    return {rows:JSON.stringify(tables.map(table=>db.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())),
      changes:db.raw.prepare('SELECT total_changes() AS n').get()};
  }
  it.each([
    ['unassociated',undefined,'allowed'],['local','fictional-workspace','allowed'],
    ['missing-authority','fictional-workspace','held'],['missing-workspace',undefined,'held'],
    ['wrong-workspace','other-workspace','held'],['worker','fictional-workspace','held'],
    ['paused','fictional-workspace','held'],['delegating','fictional-workspace','held'],
    ['revoked','fictional-workspace','held'],['one-failing-owner','fictional-workspace','held'],
    ['recipient-route','fictional-workspace','held'],['recipient-route-local','fictional-workspace','allowed'],
  ] as const)('Task7 ownership fence: %s',async(kind,workspace,state)=>{
    const draft=await readyDraft();
    if(kind!=='unassociated') {
      associate('fixture-account',kind.startsWith('recipient-route'));
      if(kind!=='missing-authority' && kind!=='recipient-route') localOwner('fixture-account','fictional-workspace',kind==='worker'?'worker':'local',
        kind==='worker'?'active':['paused','delegating','revoked'].includes(kind)?kind:'local');
      if(kind==='one-failing-owner') associate('fixture-unowned-account');
    }
    authorityService(workspace);
    // Independent real-fence oracle proves the selected SQL ownership branch.
    const fence=()=>db.raw.transaction(()=>assertLocalEmailAuthority(db,{personId,recipient:draft.recipient,expectedWorkspaceId:workspace})).deferred();
    if(state==='allowed') expect(fence).not.toThrow(); else expect(fence).toThrow('email_authority_unavailable');
    const before=readBytes();
    expect(await service.inspectLocalAuthority({draftId:draft.id,expectedRevision:draft.revision})).toEqual({
      draftId:draft.id,expectedRevision:draft.revision,personId,contactMethodId,state,
      reason:state==='allowed'?null:'email_authority_unavailable',checkedAt:now(),
    });
    expect(readBytes()).toEqual(before);expect(sent).toEqual([]);
  },10000);

  it.each(['allowed','held','failed'] as const)('Task7 fresh first read is recovery-pure: %s',async mode=>{
    // Seed through the real repository, never warm this service via open/save/ready.
    const repo=new EmailRepository(db);
    const current=db.raw.prepare(`SELECT id,person_id AS personId,kind,normalized_value AS normalizedValue,
      validation_state AS validationState,updated_at AS updatedAt FROM person_contact_methods WHERE id=?`).get(contactMethodId) as Parameters<typeof contactSnapshot>[0];
    const seeded=repo.create({id:'fictional-interrupted-draft',personId,salesCycleId:'email-cycle',contactMethodId,
      recipient:current.normalizedValue,contactSnapshot:contactSnapshot(current),accountEmail:setup.accountEmail,footer:'Fictional footer',updatedAt:now()});
    const edited=repo.save({draftId:seeded.id,expectedRevision:seeded.revision,subject:'Reviewed',body:'Exact private saved prose'},now());
    db.raw.transaction(()=>repo.reserve({email:{commandId:randomUUID(),from:setup.accountEmail!,to:edited.recipient,subject:edited.subject,body:edited.body},
      draftId:edited.id,draftRevision:edited.revision,personId,salesCycleId:'email-cycle',prospectId:'email-prospect',cycleVersion:1,action:null,policyId:'fictional-policy',createdAt:now()})).immediate();
    if(mode==='held') associate('fixture-missing-owner');
    authorityService();
    const forbidden=['status','configure','connectGmail','disconnectGmail','generate','prepare'] as const;
    const spies=forbidden.map(method=>vi.spyOn(providers,method));
    const domainSpy=vi.fn();domainEntered=domainSpy;
    const before=readBytes();const request={draftId:mode==='failed'?'missing-draft':edited.id,expectedRevision:repo.get(edited.id).revision};
    try {
      expect(repo.get(edited.id).status).toBe('sending');
      expect(db.raw.prepare('SELECT * FROM email_send_results').all()).toEqual([]);
      for(let count=0;count<2;count++) {
        if(mode==='failed') await expect(service.inspectLocalAuthority(request)).rejects.toThrow();
        else expect(await service.inspectLocalAuthority(request)).toMatchObject({state:mode,reason:mode==='allowed'?null:'email_authority_unavailable'});
        expect(readBytes()).toEqual(before);
      }
      for(const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(domainSpy).not.toHaveBeenCalled();expect(contexts).toEqual([]);expect(sent).toEqual([]);
    } finally { for(const spy of spies) spy.mockRestore(); }
  },10000);

  it.each(['revision','person','kind','email','validation','updatedAt','private-snapshot'] as const)('Task7 refuses changed saved binding: %s',async change=>{
    const draft=await readyDraft();const request={draftId:draft.id,expectedRevision:draft.revision};
    expect((await service.inspectLocalAuthority(request)).state).toBe('allowed');
    if(change==='revision') request.expectedRevision++;
    if(change==='person') {const other=seedProspect(db.raw,'authority-other');db.raw.prepare('UPDATE person_contact_methods SET person_id=? WHERE id=?').run(other.personId,contactMethodId);}
    if(change==='kind') db.raw.prepare("UPDATE person_contact_methods SET kind='phone' WHERE id=?").run(contactMethodId);
    if(change==='email') db.raw.prepare("UPDATE person_contact_methods SET normalized_value='changed@example.com' WHERE id=?").run(contactMethodId);
    if(change==='validation') db.raw.prepare("UPDATE person_contact_methods SET validation_state='unverified' WHERE id=?").run(contactMethodId);
    if(change==='updatedAt') db.raw.prepare('UPDATE person_contact_methods SET updated_at=? WHERE id=?').run('2026-09-09T00:00:00.000Z',contactMethodId);
    if(change==='private-snapshot') db.raw.prepare("UPDATE email_drafts SET contact_snapshot=? WHERE id=?").run('0'.repeat(64),draft.id);
    const before=readBytes();
    const result=await service.inspectLocalAuthority(request).then(value=>({value}),error=>({error}));
    if('value' in result) expect(result.value).toMatchObject({state:'held'}); else expect(result.error).toBeInstanceOf(Error);
    expect(readBytes()).toEqual(before);expect(sent).toEqual([]);
  },10000);

  it.each(['recipient','personId','contactSnapshot','expectedWorkspaceId'] as const)('Task7 rejects caller-injected %s',async key=>{
    const draft=await readyDraft();const before=readBytes();
    await expect(service.inspectLocalAuthority({...{draftId:draft.id,expectedRevision:draft.revision},[key]:'forged'} as never)).rejects.toThrow();
    expect(readBytes()).toEqual(before);expect(sent).toEqual([]);
  },10000);

  it.each(['invalidate','lock','dispose'] as const)('Task7 rejects delayed read after %s',async mode=>{
    const draft=await readyDraft();const request={draftId:draft.id,expectedRevision:draft.revision};
    expect((await service.inspectLocalAuthority(request)).state).toBe('allowed');
    let release!:()=>void;let entered!:()=>void;
    const reached=new Promise<void>(resolve=>{entered=resolve;});
    databaseDelay=new Promise<void>(resolve=>{release=resolve;});databaseEntered=entered;
    const reading=Promise.resolve().then(()=>service.inspectLocalAuthority(request)).then(value=>({value}),error=>({error}));
    let watchdog:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([reached,new Promise<never>((_,reject)=>{watchdog=setTimeout(()=>reject(Error('database gate entry not observed')),2000);})]);
      if(mode==='dispose') service.dispose();else service.invalidate(mode==='lock'?true:undefined);
      release();const result=await reading;
      expect(result).toHaveProperty('error');if('error' in result) expect(result.error).toBeInstanceOf(Error);
      expect(sent).toEqual([]);
    } finally {if(watchdog!==undefined) clearTimeout(watchdog);release();await reading;databaseDelay=null;databaseEntered=()=>undefined;}
  },10000);

  it('Task7 manual draft save and reopen remain usable with model and Gmail unconfigured',async()=>{
    setup.model='unconfigured';setup.gmail='unconfigured';setup.accountEmail=null;
    const draft=await readyDraft();
    expect((await service.inspectLocalAuthority({draftId:draft.id,expectedRevision:draft.revision})).state).toBe('allowed');
    const reopened=await service.openDraft({personId,contactMethodId});
    expect(reopened.id).toBe(draft.id);expect(reopened.subject).toBe(draft.subject);expect(reopened.body).toBe(draft.body);
    expect(contexts).toEqual([]);expect(sent).toEqual([]);
  },10000);
  it('Task7 ownership observation never replaces final Send suppression recheck',async()=>{
    const draft=await readyDraft();
    expect((await service.inspectLocalAuthority({draftId:draft.id,expectedRevision:draft.revision})).state).toBe('allowed');
    domain.logCallOutcome({personId,salesCycleId:'email-cycle',outcome:'opted_out',callbackAt:null,occurredAt:now()});
    await expect(service.sendDraft({draftId:draft.id,expectedRevision:draft.revision,commandId:randomUUID()})).rejects.toThrow();
    expect(sent).toEqual([]);expect(db.raw.prepare('SELECT * FROM email_send_intents').all()).toEqual([]);
  },10000);
});
