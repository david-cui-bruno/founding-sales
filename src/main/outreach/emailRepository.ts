import { createHash } from 'node:crypto';
import type { AppDatabase } from '../db/database';
import { emailDraftSchema, type EmailDraft, type SaveDraftRequest } from '../../shared/contracts/outreachContract';
import type { EmailSendResult, FrozenEmail } from './providers/providerTypes';

export type StoredDraft = EmailDraft & {contactSnapshot:string;accountEmail:string|null;footer:string};
export type EmailActionBinding = {id:string;version:number;enrollmentId:string|null;enrollmentVersion:number|null;stepId:string|null;componentId:string|null;type:string};
export type EmailReservation = {email:FrozenEmail;draftId:string;draftRevision:number;personId:string;salesCycleId:string;prospectId:string;cycleVersion:number;action:EmailActionBinding|null;policyId:string;createdAt:string};
const columns = `id, person_id AS personId, sales_cycle_id AS salesCycleId, contact_method_id AS contactMethodId,
 recipient, contact_snapshot AS contactSnapshot, account_email AS accountEmail, sender_footer AS footer, subject, body, revision, status,
 generation, message_id AS messageId, notice, updated_at AS updatedAt`;
export class EmailRepository {
  constructor(readonly database:AppDatabase) {}
  get(id:string):StoredDraft {
    const row=this.database.raw.prepare(`SELECT ${columns} FROM email_drafts WHERE id=?`).get(id) as StoredDraft|undefined;
    if (!row) throw new Error('email_draft_not_found');
    return row;
  }
  findOpen(salesCycleId:string,contactMethodId:string):StoredDraft|null {
    return (this.database.raw.prepare(`SELECT ${columns} FROM email_drafts WHERE sales_cycle_id=? AND contact_method_id=? AND status<>'sent'`).get(salesCycleId,contactMethodId) as StoredDraft|undefined)??null;
  }
  create(input:Omit<StoredDraft,'revision'|'status'|'generation'|'messageId'|'notice'|'subject'|'body'>):StoredDraft {
    this.database.raw.prepare(`INSERT INTO email_drafts(id,person_id,sales_cycle_id,contact_method_id,recipient,contact_snapshot,
      account_email,sender_footer,subject,body,revision,status,generation,message_id,notice,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'','',1,'draft','none',NULL,NULL,?,?)`).run(input.id,input.personId,input.salesCycleId,
      input.contactMethodId,input.recipient,input.contactSnapshot,input.accountEmail,input.footer,input.updatedAt,input.updatedAt);
    return this.get(input.id);
  }
  save(input:SaveDraftRequest,now:string,generation:EmailDraft['generation']='edited'):StoredDraft {
    const changed=this.database.raw.prepare(`UPDATE email_drafts SET subject=?,body=?,generation=?,notice=NULL,
      revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='draft'`)
      .run(input.subject,input.body,generation,now,input.draftId,input.expectedRevision);
    if(changed.changes!==1)throw new Error('email_draft_changed');
    return this.get(input.draftId);
  }
  bindAccount(id:string,email:string|null,footer:string,now:string):void {
    // Only an explicit open refreshes the displayed sending identity, never send itself.
    this.database.raw.prepare("UPDATE email_drafts SET account_email=?,sender_footer=?,revision=revision+1,updated_at=? WHERE id=? AND status='draft' AND (account_email IS NOT ? OR sender_footer<>?)").run(email,footer,now,id,email,footer);
  }
  notice(id:string,message:string):StoredDraft {
    this.database.raw.prepare("UPDATE email_drafts SET notice=? WHERE id=? AND status='draft'").run(message,id);
    return this.get(id);
  }
  intent(commandId:string):EmailReservation|null {
    const row=this.database.raw.prepare('SELECT reservation_json FROM email_send_intents WHERE command_id=?').get(commandId) as {reservation_json:string}|undefined;
    return row?JSON.parse(row.reservation_json) as EmailReservation:null;
  }
  reserve(reservation:EmailReservation):void {
    const changed=this.database.raw.prepare("UPDATE email_drafts SET status='sending',revision=revision+1,notice=NULL,updated_at=? WHERE id=? AND revision=? AND status='draft'")
      .run(reservation.createdAt,reservation.draftId,reservation.draftRevision);
    if(changed.changes!==1)throw new Error('email_draft_changed');
    const hash=createHash('sha256').update(JSON.stringify(reservation.email)).digest('hex');
    this.database.raw.prepare('INSERT INTO email_send_intents(command_id,draft_id,draft_revision,content_hash,reservation_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(reservation.email.commandId,reservation.draftId,reservation.draftRevision,hash,JSON.stringify(reservation),reservation.createdAt);
  }
  finish(reservation:EmailReservation,result:EmailSendResult,now:string):StoredDraft {
    if(this.database.raw.prepare('SELECT command_id FROM email_send_results WHERE command_id=?').get(reservation.email.commandId)) return this.get(reservation.draftId);
    this.database.raw.prepare('INSERT INTO email_send_results(command_id,status,result_json,created_at) VALUES(?,?,?,?)')
      .run(reservation.email.commandId,result.status,JSON.stringify(result),now);
    const status=result.status==='accepted'?'sent':result.status==='not_sent'?'draft':'unknown';
    const notice=status==='unknown'?'Sending could not be confirmed. Check Gmail Sent before taking further action. Do not resend.':
      status==='draft'?'Gmail did not accept this message. Check the connection before trying again.':null;
    this.database.raw.prepare('UPDATE email_drafts SET status=?,message_id=?,notice=?,revision=revision+1,updated_at=? WHERE id=? AND status=\'sending\'')
      .run(status,result.status==='accepted'?result.messageId:null,notice,now,reservation.draftId);
    return this.get(reservation.draftId);
  }
}
export function publicDraft(draft:StoredDraft):EmailDraft {
  const {contactSnapshot,accountEmail,...publicFields}=draft;
  void contactSnapshot;
  return emailDraftSchema.parse({...publicFields,senderEmail:accountEmail});
}
