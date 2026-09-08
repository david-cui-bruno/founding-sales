import type { AppDatabase } from '../db/database';
import { createDomainServices, type DomainServices } from '../domain/createDomainServices';
import { contactSnapshot } from '../communications/contactSnapshot';
import type { EmailActionBinding, EmailReservation, StoredDraft } from './emailRepository';
import type { EmailSendResult } from './providers/providerTypes';

export function emailDomain(database:AppDatabase,now:()=>string,id:()=>string):DomainServices {
  return createDomainServices({database,clock:{now},ids:{next:id}});
}
type Cycle = {id:string;personId:string;prospectId:string;stage:string;workflowStatus:string;version:number;actionId:string|null;qualification:string;prospectVersion:number};
export function readEmailCycle(database:AppDatabase,id:string):Cycle {
  const cycle=database.raw.prepare(`SELECT c.id,c.person_id AS personId,c.prospect_id AS prospectId,c.stage,
    c.workflow_status AS workflowStatus,c.version,c.current_next_action_id AS actionId,p.qualification_state AS qualification,
    p.version AS prospectVersion FROM sales_cycles c JOIN prospects p ON p.id=c.prospect_id WHERE c.id=?`).get(id) as Cycle|undefined;
  if(!cycle)throw new Error('email_cycle_missing');return cycle;
}
export function readEmailAction(database:AppDatabase,cycle:Cycle):EmailActionBinding|null {
  if(!cycle.actionId)return null;
  return (database.raw.prepare(`SELECT a.id,a.version,a.action_type AS type,a.cadence_enrollment_id AS enrollmentId,
    a.cadence_step_id AS stepId,a.cadence_component_id AS componentId,e.version AS enrollmentVersion
    FROM next_actions a LEFT JOIN cadence_enrollments e ON e.id=a.cadence_enrollment_id
    WHERE a.id=? AND a.sales_cycle_id=? AND a.status='pending'`).get(cycle.actionId,cycle.id) as EmailActionBinding|undefined)??null;
}
/** Email has its own policy: phone DNC/window clearances are not email permission. */
export function authorizeEmail(database:AppDatabase,services:DomainServices,draft:StoredDraft,now:string):Cycle {
  services.unitOfWork.assertWriteScope();
  const person=services.identities.getPerson(draft.personId);
  const contact=services.identities.getContactMethod(draft.contactMethodId);
  let cycle=readEmailCycle(database,draft.salesCycleId);
  if(!person || person.deletedAt || person.optedOut)throw new Error('email_person_suppressed');
  services.outboundPermission.assertMayContactPerson(person.id);
  if(!contact || contact.personId!==person.id || contact.kind!=='email' || contact.validationState!=='valid'
    || contact.presentationEvidence?.ownershipState==='conflicting_identity')throw new Error('email_contact_not_valid');
  services.outboundPermission.assertMayContactHandle('email',contact.normalizedValue);
  if(contact.normalizedValue!==draft.recipient || contactSnapshot(contact)!==draft.contactSnapshot)throw new Error('email_contact_changed');
  if(cycle.personId!==person.id || cycle.workflowStatus==='closed' || !['eligible','unreviewed'].includes(cycle.qualification))throw new Error('email_cycle_not_executable');
  if(cycle.stage==='unreviewed') {
    services.lifecycle.scopedWriter().reviewToReady({cycleId:cycle.id,expectedCycleVersion:cycle.version,
      expectedProspectVersion:cycle.prospectVersion,effectiveAt:now});
    cycle=readEmailCycle(database,cycle.id);
  }
  if(cycle.qualification!=='eligible')throw new Error('email_cycle_not_executable');
  if(!['ready','contacted','interviewed','offered','won'].includes(cycle.stage))throw new Error('email_cycle_not_executable');
  return cycle;
}
export function recordEmailAcceptance(database:AppDatabase,services:DomainServices,reservation:EmailReservation,
  result:Extract<EmailSendResult,{status:'accepted'}>,now:string):void {
  services.unitOfWork.assertWriteScope();
  const cycle=readEmailCycle(database,reservation.salesCycleId);
  const action=readEmailAction(database,cycle);
  const binding=reservation.action;
  const matching=cycle.version===reservation.cycleVersion && action?.id===binding?.id
    && action?.version===binding?.version && action?.enrollmentVersion===binding?.enrollmentVersion;
  const bound=matching && binding?.type==='email' && binding.enrollmentId && binding.stepId && binding.componentId;
  const activity=services.events.appendActivity({personId:reservation.personId,prospectId:reservation.prospectId,
    ...(bound?{salesCycleId:reservation.salesCycleId,cadenceEnrollmentId:binding.enrollmentId!,cadenceStepId:binding.stepId!,cadenceComponentId:binding.componentId!}:{salesCycleId:reservation.salesCycleId,cadenceEnrollmentId:null,cadenceStepId:null,cadenceComponentId:null}),
    kind:'email',direction:'outbound',channel:'email',occurredAt:now,observedOutcome:'accepted',
    adapter:'fss_gmail_v1',providerIdempotencyKey:reservation.email.commandId,providerReference:result.messageId,
    consentPolicyRecordId:reservation.policyId,
    metadata:{formatVersion:1,summary:`Email: ${reservation.email.subject}`,gmailAccepted:true,deliveryConfirmed:false,
      commandId:reservation.email.commandId,threadId:result.threadId}});
  const person=services.identities.getPerson(reservation.personId);
  // A late accepted receipt is still evidence. It never revives an opted-out or changed cycle.
  if(!matching || !person || person.optedOut || services.outboundPermission.inspectPerson(person.id).kind==='blocked'
    || cycle.workflowStatus==='closed')return;
  if(bound && binding.enrollmentVersion!==null) {
    services.lifecycle.scopedWriter().completeCurrentAction({cycleId:cycle.id,expectedCycleVersion:cycle.version,
      expectedCurrentActionId:binding.id,expectedActionVersion:binding.version,expectedEnrollmentVersion:binding.enrollmentVersion,
      outcome:'accepted',activityId:activity.id,impossibleDisposition:null,evaluationAt:now,manualReactivationDueAt:null});
  } else if(cycle.stage==='ready' && cycle.actionId) {
    services.lifecycle.scopedWriter().recordQualifyingContact({cycleId:cycle.id,expectedCycleVersion:cycle.version,
      expectedCurrentActionId:cycle.actionId,activityId:activity.id,effectiveAt:now});
  }
}
