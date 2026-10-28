import {z} from 'zod';
import {instant,manualProspectFeedbackPayloadSchema,manualProspectFeedbackSavedSchema,type ManualPhoneChoice} from '@fss/contracts';
export const MANUAL_PROSPECT_PENDING_KEY='callie.browser.pending-manual-prospect.v1';
const command=manualProspectFeedbackPayloadSchema;
export const manualProspectPendingSchema=z.strictObject({identity:z.string(),expiresAt:instant,payload:command,
 receipt:z.union([z.strictObject({status:z.literal('accepted'),result:manualProspectFeedbackSavedSchema}),z.strictObject({status:z.literal('refused')})]).optional()});
export type PendingManualProspect=z.infer<typeof manualProspectPendingSchema>;
/** IDs/enums only. Unknown outcomes remain held until explicit same-UUID reconciliation. */
export class ManualProspectCustody {
 constructor(private readonly storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,
  private readonly binding:()=>{identity:string;expiresAt:string}|null,private readonly uuid:()=>string){}
 clear():void{try{this.storage.removeItem(MANUAL_PROSPECT_PENDING_KEY);}catch{/* Binding still refuses old bytes. */}}
 read():PendingManualProspect|null{
  const binding=this.binding();if(!binding)return null;
  const raw=this.storage.getItem(MANUAL_PROSPECT_PENDING_KEY);if(raw===null)return null;
  const held=manualProspectPendingSchema.parse(JSON.parse(raw));
  if(held.identity!==binding.identity||Date.parse(held.expiresAt)<=Date.now()||Date.parse(held.expiresAt)>Date.parse(binding.expiresAt)){this.clear();return null;}
  return held;
 }
 retain(value:PendingManualProspect):void{
  const held=manualProspectPendingSchema.parse(value),binding=this.binding();
  if(!binding||held.identity!==binding.identity||Date.parse(held.expiresAt)<=Date.now()||Date.parse(held.expiresAt)>Date.parse(binding.expiresAt))throw Error('Manual prospect authority changed');
  const prior=this.read();
  if(prior&&!prior.receipt&&JSON.stringify(prior.payload)!==JSON.stringify(held.payload))throw Error('Reconcile pending manual feedback');
  const bytes=JSON.stringify(held);this.storage.setItem(MANUAL_PROSPECT_PENDING_KEY,bytes);
  if(this.storage.getItem(MANUAL_PROSPECT_PENDING_KEY)!==bytes)throw Error('Manual feedback storage unavailable');
 }
 prepare(input:{candidateId:string;expectedRevision:number;state:'kept'|'skipped'|'wrong_number';phoneChoice?:ManualPhoneChoice|null}):PendingManualProspect{
  const binding=this.binding();if(!binding)throw Error('Manual prospect authority unavailable');
  const prior=this.read();if(prior&&!prior.receipt)throw Error('Reconcile pending manual feedback');
  const held=manualProspectPendingSchema.parse({...binding,payload:{...input,commandId:this.uuid()}});this.retain(held);return held;
 }
}
