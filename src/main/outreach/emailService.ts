import { assertLocalEmailAuthority } from '../delegation/executionRouter';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db/database';
import type { FounderSalesDomain } from '../domain/founderSalesDomain';
import { contactSnapshot } from '../communications/contactSnapshot';
import { configureOutreachSchema,draftRevisionSchema,openDraftSchema,saveDraftSchema,sendDraftSchema,
  type EmailDraft,type LocalEmailAuthorityRead,type OutreachApi,type OutreachStatus,type SendDraftRequest } from '../../shared/contracts/outreachContract';
import type { EmailSendResult,OutreachProviders } from './providers/providerTypes';
import { EmailRepository,publicDraft,type EmailReservation } from './emailRepository';
import { authorizeEmail,emailDomain,readEmailAction,recordEmailAcceptance } from './emailEvidence';
import { EMAIL_PLAYBOOK } from './emailPlaybook';

export type EmailDatabaseGate = {
  withDatabase<T>(operation:(database:AppDatabase)=>T|Promise<T>):Promise<T>;
  withDomain<T>(operation:(domain:FounderSalesDomain)=>T|Promise<T>):Promise<T>;
};
export function createEmailService(options:{databaseGate:EmailDatabaseGate;providers:OutreachProviders;expectedWorkspaceId?:string;now?:()=>string;id?:()=>string}):OutreachApi & {dispose():void;invalidate(locked?:boolean):void} {
  const expectedWorkspaceId=options.expectedWorkspaceId;
  const gate=options.databaseGate, providers=options.providers, now=options.now??(()=>new Date().toISOString()), id=options.id??randomUUID;
  let closed=false,locked=false,epoch=0,initialized:Promise<void>|undefined;
  const controllers=new Set<AbortController>();
  const flights=new Map<string,{revision:number;commandId:string;promise:Promise<EmailDraft>}>();
  const assertOpen=()=>{if(closed||locked)throw new Error('email_workspace_inactive');};
  const assertCurrent=(expected:number)=>{assertOpen();if(epoch!==expected)throw new Error('email_workspace_changed');};
  const ready=()=> initialized??=gate.withDatabase(db=>db.raw.transaction(()=>{
    const repo=new EmailRepository(db);
    const rows=db.raw.prepare(`SELECT i.reservation_json FROM email_send_intents i JOIN email_drafts d ON d.id=i.draft_id
      LEFT JOIN email_send_results r ON r.command_id=i.command_id WHERE d.status='sending' AND r.command_id IS NULL`).all() as {reservation_json:string}[];
    for(const row of rows)repo.finish(JSON.parse(row.reservation_json) as EmailReservation,{status:'unknown',reasonCode:'interrupted_send'},now());
  }).immediate());
  const invalidate=(lock?:boolean)=>{if(lock!==undefined)locked=lock;epoch++;providers.invalidate?.();for(const controller of controllers)controller.abort();controllers.clear();};
  const api:OutreachApi & {dispose():void;invalidate(locked?:boolean):void}={
    status:()=>providers.status(),
    configure:input=>{assertOpen();invalidate();return providers.configure(configureOutreachSchema.parse(input));},
    connectGmail:()=>{assertOpen();invalidate();return providers.connectGmail();},
    disconnectGmail:()=>{assertOpen();invalidate();return providers.disconnectGmail();},
    dispose:()=>{closed=true;invalidate();providers.dispose();},invalidate,
    async inspectLocalAuthority(input) {
      assertOpen();const startEpoch=epoch;const request=draftRevisionSchema.parse(input);
      // Do not call ready(): observation must not repair interrupted Sending rows.
      const result=await gate.withDatabase(db=>{
        assertCurrent(startEpoch);
        const read=():LocalEmailAuthorityRead=>{
          assertCurrent(startEpoch);
          const draft=new EmailRepository(db).get(request.draftId);
          if(draft.revision!==request.expectedRevision||draft.supersededAt!==null)throw new Error('email_draft_changed');
          const current=db.raw.prepare(`SELECT id,person_id AS personId,kind,normalized_value AS normalizedValue,
            validation_state AS validationState,updated_at AS updatedAt FROM person_contact_methods WHERE id=?`).get(draft.contactMethodId) as Parameters<typeof contactSnapshot>[0]|undefined;
          let reason:LocalEmailAuthorityRead['reason']=null;
          if(!current||current.personId!==draft.personId||current.kind!=='email'||current.normalizedValue!==draft.recipient
            ||contactSnapshot(current)!==draft.contactSnapshot) reason='email_contact_changed';
          else {
            try {assertLocalEmailAuthority(db,{personId:draft.personId,recipient:draft.recipient,expectedWorkspaceId});}
            catch(error) {
              if(!(error instanceof Error)||error.message!=='email_authority_unavailable')throw error;
              reason='email_authority_unavailable';
            }
          }
          const observed:LocalEmailAuthorityRead={...request,personId:draft.personId,contactMethodId:draft.contactMethodId,
            state:reason===null?'allowed':'held',reason,checkedAt:now()};
          assertCurrent(startEpoch);return observed;
        };
        return db.raw.inTransaction?read():db.raw.transaction(read).deferred();
      });
      assertCurrent(startEpoch);return result;
    },
    async openDraft(input) {
      assertOpen();const startEpoch=epoch;const request=openDraftSchema.parse(input);await ready();assertCurrent(startEpoch);
      const detail=await gate.withDomain(domain=>domain.getLeadDetail({personId:request.personId}));
      assertCurrent(startEpoch);
      const contact=detail.emails.find(item=>item.id===request.contactMethodId);
      if(!contact)throw new Error('email_contact_missing');
      const setup=await providers.status();assertCurrent(startEpoch);
      const opened=await gate.withDatabase(db=>db.raw.transaction(()=>{
        assertCurrent(startEpoch);
        const repo=new EmailRepository(db);const old=repo.findOpen(detail.salesCycleId,contact.id);
        const current=db.raw.prepare(`SELECT id,person_id AS personId,kind,normalized_value AS normalizedValue,
          validation_state AS validationState,updated_at AS updatedAt FROM person_contact_methods WHERE id=?`).get(contact.id) as Parameters<typeof contactSnapshot>[0]|undefined;
        if(!current || current.personId!==detail.personId || current.kind!=='email' || current.normalizedValue!==contact.value)throw new Error('email_contact_changed');
        if(old){
          if(old.status!=='draft'||old.contactSnapshot===contactSnapshot(current)){
            repo.bindAccount(old.id,setup.accountEmail,emailFooter(setup),now());return {draft:repo.get(old.id),created:false};
          }
          // Never silently retarget reviewed content. Preserve it and start a new draft
          // only on this explicit open. Sending/unknown drafts cannot take this path.
          repo.supersede(old.id,now());
        }
        const draft=repo.create({id:id(),personId:detail.personId,salesCycleId:detail.salesCycleId,contactMethodId:contact.id,
          recipient:current.normalizedValue,contactSnapshot:contactSnapshot(current),accountEmail:setup.accountEmail,footer:emailFooter(setup),updatedAt:now()});
        return {draft,created:true};
      }).immediate());
      assertCurrent(startEpoch);
      if(opened.created && setup.model==='ready')return api.generateDraft({draftId:opened.draft.id,expectedRevision:opened.draft.revision});
      if(opened.created && setup.model!=='ready')return gate.withDatabase(db=>{assertCurrent(startEpoch);return publicDraft(new EmailRepository(db).notice(opened.draft.id,'Add your model key in Settings → Connections for a prepared draft. You can also write this email yourself.'));});
      return publicDraft(opened.draft);
    },
    async saveDraft(input) {
      assertOpen();const startEpoch=epoch;const request=saveDraftSchema.parse(input);await ready();assertCurrent(startEpoch);
      return gate.withDatabase(db=>{assertCurrent(startEpoch);return publicDraft(new EmailRepository(db).save(request,now()));});
    },
    async generateDraft(input) {
      assertOpen();const request=draftRevisionSchema.parse(input);const startEpoch=epoch;
      const controller=new AbortController();controllers.add(controller);
      try {
        await ready();assertCurrent(startEpoch);
        const draft=await gate.withDatabase(db=>new EmailRepository(db).get(request.draftId));
        assertCurrent(startEpoch);
        if(draft.status!=='draft'||draft.supersededAt!==null||draft.revision!==request.expectedRevision)throw new Error('email_draft_changed');
        const detail=await gate.withDomain(domain=>domain.getLeadDetail({personId:draft.personId}));
        assertCurrent(startEpoch);
        if(detail.salesCycleId!==draft.salesCycleId)throw new Error('email_cycle_changed');
        const facts=[...(detail.portfolio?.facts??[])];
        // Local-only notes, raw activity summaries and transcripts are deliberately excluded.
        const result=await providers.generate({personName:detail.personName,organizationLabel:detail.organizationLabel,
          segment:detail.segment,stage:detail.stage,actionLabel:detail.nextAction?.label??null,facts:facts.slice(0,40),playbook:EMAIL_PLAYBOOK},controller.signal);
        assertCurrent(startEpoch);
        const saved=saveDraftSchema.parse({...request,subject:result.subject,body:result.body});
        return await gate.withDatabase(db=>{assertCurrent(startEpoch);return publicDraft(new EmailRepository(db).save(saved,now(),'model'));});
      } catch(error) {
        assertCurrent(startEpoch);
        if(error instanceof Error && ['email_draft_changed','email_cycle_changed'].includes(error.message))throw error;
        return gate.withDatabase(db=>{assertCurrent(startEpoch);return publicDraft(new EmailRepository(db).notice(request.draftId,'Could not prepare the email. Your existing draft is unchanged. Check Settings → Connections.'));});
      } finally {controllers.delete(controller);}
    },
    sendDraft(input) {
      assertOpen();const request=sendDraftSchema.parse(input);
      const existing=flights.get(request.draftId);
      if(existing){if(existing.commandId===request.commandId && existing.revision===request.expectedRevision)return existing.promise;
        return Promise.reject(new Error('email_send_in_progress'));}
      const promise=send(request).finally(()=>flights.delete(request.draftId));
      flights.set(request.draftId,{revision:request.expectedRevision,commandId:request.commandId,promise});return promise;
    },
  };
  async function send(request:SendDraftRequest):Promise<EmailDraft> {
    const startEpoch=epoch;await ready();assertCurrent(startEpoch);
    const replay=await gate.withDatabase(db=>{
      const repo=new EmailRepository(db),previous=repo.intent(request.commandId),draft=repo.get(request.draftId);
      if(previous){if(previous.draftId!==request.draftId||previous.draftRevision!==request.expectedRevision)throw new Error('email_command_conflict');return publicDraft(draft);}
      return draft.status==='draft'?null:publicDraft(draft);
    });
    if(replay)return replay;
    assertCurrent(startEpoch);
    const setup=await providers.status();assertCurrent(startEpoch);
    if(setup.gmail!=='ready'||!setup.accountEmail||!setup.senderName.trim()||!setup.postalAddress.trim())throw new Error('email_sender_setup_required');
    const controller=new AbortController();controllers.add(controller);
    try {
      assertCurrent(startEpoch);
      const prepared=await providers.prepare(controller.signal);assertCurrent(startEpoch);
      // Hold the database lease across dispatch/result. No await between final serialized authority and sendOnce.
      return await gate.withDatabase(async db=>{
        const repo=new EmailRepository(db),services=emailDomain(db,now,id);
        const reservation=services.unitOfWork.immediate(()=>{
          if(closed||epoch!==startEpoch||controller.signal.aborted)throw new Error('email_workspace_changed');
          const draft=repo.get(request.draftId);
          if(draft.revision!==request.expectedRevision||draft.status!=='draft'||draft.supersededAt!==null)throw new Error('email_draft_changed');
          if(draft.footer!==emailFooter(setup)||draft.accountEmail!==prepared.accountEmail||setup.accountEmail!==prepared.accountEmail)throw new Error('email_sender_changed');
          assertLocalEmailAuthority(db,{personId:draft.personId,recipient:draft.recipient,expectedWorkspaceId});
          if(!draft.subject.trim()||!draft.body.trim())throw new Error('email_content_required');
          const createdAt=now(),cycle=authorizeEmail(db,services,draft,createdAt);
          const policy=services.events.appendConsentPolicyRecord({personId:draft.personId,policyKind:'outbound',policyVersion:'fss-email-explicit-v1',
            effectiveAt:createdAt,decision:'granted',evidence:{explicitSend:true,commandId:request.commandId,contactMethodId:draft.contactMethodId,
              contactSnapshot:draft.contactSnapshot,sender:prepared.accountEmail,personWideSuppressionChecked:true,postalAddressPresent:true,replyOptOut:true}});
          const value:EmailReservation={email:{commandId:request.commandId,from:prepared.accountEmail,to:draft.recipient,subject:draft.subject,
            body:`${draft.body}\n\n${draft.footer}`},draftId:draft.id,draftRevision:draft.revision,
            personId:draft.personId,salesCycleId:cycle.id,prospectId:cycle.prospectId,cycleVersion:cycle.version,
            action:readEmailAction(db,cycle),policyId:policy.id,createdAt};
          repo.reserve(value);return value;
        });
        let result:EmailSendResult;
        try {result=await prepared.sendOnce(reservation.email);}catch{result={status:'unknown',reasonCode:'network_uncertain'};}
        try {
          return services.unitOfWork.immediate(()=>{
            if(result.status==='accepted')recordEmailAcceptance(db,services,reservation,result,now());
            return publicDraft(repo.finish(reservation,result,now()));
          });
        }catch {
          // Never retry a committed intent, even if receipt/evidence persistence failed after acceptance.
          return services.unitOfWork.immediate(()=>publicDraft(repo.finish(reservation,{status:'unknown',reasonCode:'result_not_persisted'},now())));
        }
      });
    }finally{controllers.delete(controller);}
  }
  return api;
}

function emailFooter(setup:OutreachStatus):string {
  return `${setup.senderName}\n${setup.postalAddress}\nTo stop these emails, reply "stop".`;
}
