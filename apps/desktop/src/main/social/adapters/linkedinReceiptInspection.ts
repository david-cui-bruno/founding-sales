import {z} from 'zod';
import type {InspectionResult} from '../adapters.ts';
import {matchLinkedInReceipt} from './linkedinReceiptMatch.ts';
const receipt=z.string().regex(/^urn:li:share:\d+$/);
const expectedSchema=z.strictObject({accountExternalId:z.string().min(1).max(300),postingName:z.string().min(1).max(200),text:z.string().min(1).max(3000),publishAt:z.string().datetime({offset:true}),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),images:z.array(z.unknown()).max(20)});
const rowSchema=z.strictObject({receiptId:receipt,text:z.string().max(10000),scheduleLabel:z.string().max(150),images:z.array(z.unknown()).max(20)});
const listSchema=z.strictObject({ok:z.literal(true),total:z.number().int().min(0).max(10000),complete:z.boolean(),rows:z.array(rowSchema).max(100),zone:z.string().min(1).max(100)});
const detailSchema=z.strictObject({receiptId:receipt,postingName:z.string().max(200),text:z.string().max(10000),scheduleLabel:z.string().max(150),zone:z.string().min(1).max(100),images:z.array(z.unknown()).max(20),altTextVerified:z.boolean()});
interface Port{
 current():boolean;now():number;account():Promise<string|null>;
 /** Read-only list plus browser-observed timezone. */
 list():Promise<unknown>;
 /** Open this exact native row and read saved details; must not save edits.
  * receiptId must be bound to that navigation, never copied from approval.
  */
 detail(receiptId:string):Promise<unknown>;
}
/** Text-only receipt recovery. Missing scheduled rows may already be published;
 * even a complete empty scheduled list never authorizes resubmission.
 */
export async function inspectLinkedInTextReceipt(raw:unknown,receiptId:string|null,port:Port):Promise<InspectionResult>{
 const unknown=():InspectionResult=>({state:'unknown',receiptId:null,permalink:null,observedAt:new Date(port.now()).toISOString(),accountExternalId:null,observedFingerprint:null,complete:false});
 try{
  const expected=expectedSchema.parse(raw);if(expected.images.length||!port.current())return unknown();
  if(receiptId!==null)receipt.parse(receiptId);
  if(await port.account()!==expected.accountExternalId||!port.current())return unknown();
  const list=listSchema.parse(await port.list());if(!port.current()||!list.complete||list.rows.length!==list.total)return unknown();
  if(new Set(list.rows.map(r=>r.receiptId)).size!==list.rows.length)return unknown();
  const at=new Date(expected.publishAt);
  const fields=(instant:Date)=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:list.zone,year:'numeric',month:'short',day:'numeric',weekday:'short',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(instant).map(p=>[p.type,p.value]));
  const f=fields(at);if(at.getUTCSeconds()||at.getUTCMilliseconds())return unknown();
  for(const delta of [-3600_000,3600_000])if(JSON.stringify(fields(new Date(at.getTime()+delta)))===JSON.stringify(f))return unknown();
  const time=`${f['hour']}:${f['minute']} ${f['dayPeriod']}`;
  const listLabel=`Posting ${f['weekday']}, ${f['month']} ${f['day']}, ${f['year']} at ${time}`;
  const detailLabel=`Posting at ${f['weekday']}, ${f['month']} ${f['day']}, ${time}`;
  const candidates=list.rows.filter(r=>(receiptId===null||r.receiptId===receiptId)&&r.text===expected.text&&r.scheduleLabel===listLabel&&r.images.length===0);
  if(candidates.length!==1)return unknown();const candidate=candidates[0]!;
  const detail=detailSchema.parse(await port.detail(candidate.receiptId));
  if(!port.current()||detail.receiptId!==candidate.receiptId||detail.postingName!==expected.postingName||detail.zone!==list.zone||detail.scheduleLabel!==detailLabel||detail.images.length)return unknown();
  if(await port.account()!==expected.accountExternalId||!port.current())return unknown();
  const match=matchLinkedInReceipt({receiptId:candidate.receiptId,accountExternalId:expected.accountExternalId,text:expected.text,publishAt:expected.publishAt,fingerprint:expected.fingerprint,images:[]},{receiptId:detail.receiptId,accountExternalId:expected.accountExternalId,text:detail.text,publishAt:expected.publishAt,detailComplete:true,images:[]},null);
  if(!match)return unknown();
  return {state:'scheduled',receiptId:detail.receiptId,permalink:null,observedAt:new Date(port.now()).toISOString(),accountExternalId:expected.accountExternalId,observedFingerprint:expected.fingerprint,complete:true};
 }catch{return unknown();}
}
