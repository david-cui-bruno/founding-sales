import {z} from 'zod';
import {socialMediaBindingSchema,type SocialMediaBinding} from '@fss/contracts';
import type {InspectionResult} from '../adapters.ts';
import {matchLinkedInReceipt,linkedInMediaId} from './linkedinReceiptMatch.ts';
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
export function inspectLinkedInTextReceipt(raw:unknown,receiptId:string|null,port:Port):Promise<InspectionResult>{return inspectReceipt(raw,receiptId,port,null);}
/** Restart recovery requires an original persisted mapping; never reconstruct it
 * from matching text/time or a thumbnail encountered during this lookup. */
export function inspectLinkedInImageReceipt(raw:unknown,binding:unknown,port:Port):Promise<InspectionResult>{
 const parsed=socialMediaBindingSchema.safeParse(binding);
 return inspectReceipt(raw,parsed.success?parsed.data.receiptId:null,port,parsed.success?parsed.data:null,true);
}
async function inspectReceipt(raw:unknown,receiptId:string|null,port:Port,binding:SocialMediaBinding|null,imageMode=false):Promise<InspectionResult>{
 const unknown=():InspectionResult=>({state:'unknown',receiptId:null,permalink:null,observedAt:new Date(port.now()).toISOString(),accountExternalId:null,observedFingerprint:null,complete:false});
 try{
  const expected=expectedSchema.parse(raw);if(!port.current()||(!imageMode&&expected.images.length)||(imageMode&&(!binding||expected.images.length!==1)))return unknown();
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
  const candidates=list.rows.filter(r=>(receiptId===null||r.receiptId===receiptId)&&r.text===expected.text&&r.scheduleLabel===listLabel&&r.images.length===expected.images.length);
  if(candidates.length!==1)return unknown();const candidate=candidates[0]!;
  if(imageMode){
   const previews=z.array(z.object({src:z.string()})).parse(candidate.images);
   if(previews.some((image,index)=>linkedInMediaId(image.src)!==binding!.images[index]?.platformId))return unknown();
  }
  const detail=detailSchema.parse(await port.detail(candidate.receiptId));
  if(!port.current()||detail.receiptId!==candidate.receiptId||detail.postingName!==expected.postingName||detail.zone!==list.zone||detail.scheduleLabel!==detailLabel||detail.images.length!==expected.images.length||(imageMode&&!detail.altTextVerified))return unknown();
  if(await port.account()!==expected.accountExternalId||!port.current())return unknown();
  const match=matchLinkedInReceipt({receiptId:candidate.receiptId,accountExternalId:expected.accountExternalId,text:expected.text,publishAt:expected.publishAt,fingerprint:expected.fingerprint,images:expected.images},{receiptId:detail.receiptId,accountExternalId:expected.accountExternalId,text:detail.text,publishAt:expected.publishAt,detailComplete:true,images:detail.images},binding);
  if(!match)return unknown();
  return {state:'scheduled',receiptId:detail.receiptId,permalink:null,observedAt:new Date(port.now()).toISOString(),accountExternalId:expected.accountExternalId,observedFingerprint:expected.fingerprint,complete:true,...(binding?{mediaBinding:binding}:{})};
 }catch{return unknown();}
}

/** Initial submission only: capture is read from the original draft's observer
 * before navigating away. Baseline receipts prevent adopting a pre-existing post.
 */
export async function inspectLinkedInSubmittedImage(raw:unknown,capture:unknown,baseline:readonly string[],port:Port):Promise<InspectionResult>{
 const unknown=():InspectionResult=>({state:'unknown',receiptId:null,permalink:null,observedAt:new Date(port.now()).toISOString(),accountExternalId:null,observedFingerprint:null,complete:false});
 try{
  const expected=expectedSchema.parse(raw);
  const proof=z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/),platformId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)}).parse(capture);
  const images=z.array(z.strictObject({sha256:z.string(),altText:z.string()})).length(1).parse(expected.images);
  if(images[0]!.sha256!==proof.sha256||!port.current())return unknown();
  const list=listSchema.parse(await port.list());if(!list.complete||list.rows.length!==list.total||!port.current())return unknown();
  const candidates=list.rows.filter(row=>!baseline.includes(row.receiptId)&&row.text===expected.text&&row.images.length===1&&z.object({src:z.string()}).safeParse(row.images[0]).success&&linkedInMediaId((row.images[0] as {src:string}).src)===proof.platformId);
  if(candidates.length!==1)return unknown();
  return inspectLinkedInImageReceipt(expected,{receiptId:candidates[0]!.receiptId,fingerprint:expected.fingerprint,images:[proof]},port);
 }catch{return unknown();}
}
