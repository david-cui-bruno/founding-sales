import type {ApprovedPost,SocialAdapter,InspectionResult} from './adapters.ts';
type Refused={ok:false;reason:string};
export interface DeliveryPorts {
 current():boolean;now():number;
 claim(post:ApprovedPost):Promise<Refused|{ok:true;claimId:string;approvalId:string;fingerprint:string;expiresAt:string}>;
 begin(input:{claimId:string;approvalId:string;fingerprint:string}):Promise<Refused|{ok:true;submissionId:string}>;
 observe(submissionId:string,observation:InspectionResult):Promise<boolean>;
}
export type DeliveryAttempt={state:'not_submitted';reason:string}|{state:'scheduled'|'published'|'unknown'};
/** One attempt, no retry loop. A marker or external-click ambiguity requires inspection. */
export async function submitApprovedSocialPost(input:ApprovedPost,adapter:SocialAdapter,port:DeliveryPorts):Promise<DeliveryAttempt>{
 const post=structuredClone(input);Object.freeze(post.account);post.images.forEach(Object.freeze);Object.freeze(post.images);Object.freeze(post);
 const held=(reason:string):DeliveryAttempt=>({state:'not_submitted',reason});
 const future=()=>Number.isFinite(Date.parse(post.publishAt))&&Date.parse(post.publishAt)>port.now();
 const same=async()=>{const a=await adapter.inspectAccount();return a?.externalId===post.account.externalId&&a.platform===post.account.platform;};
 let submissionId:string|null=null,receiptId:string|null=null,markerAttempted=false;
 const unknown=():InspectionResult=>({state:'unknown',receiptId:null,permalink:null,observedAt:new Date(port.now()).toISOString(),accountExternalId:null,observedFingerprint:null,complete:false});
 try{
  if(!port.current())return held('session_changed');if(!future())return held('schedule_missed');
  const claim=await port.claim(post);if(!claim.ok)return held(claim.reason);
  if(claim.fingerprint!==post.fingerprint)return held('approval_changed');
  const leaseLive=()=>Number.isFinite(Date.parse(claim.expiresAt))&&Date.parse(claim.expiresAt)>port.now();
  if(!port.current()||!leaseLive())return held('claim_expired');
  if(!await same())return held('account_identity_changed');
  if(!port.current())return held('session_changed');
  const staged=await adapter.stage(post);if(!staged.ready)return held(staged.reason??'staging_failed');
  if(!port.current())return held('session_changed');if(!future()||!leaseLive())return held('claim_expired');
  if(!await same())return held('account_identity_changed');
  if(!port.current()||!future()||!leaseLive())return held('claim_expired');
  markerAttempted=true;
  const began=await port.begin({claimId:claim.claimId,approvalId:claim.approvalId,fingerprint:claim.fingerprint});
  if(!began.ok)return held(began.reason);
  submissionId=began.submissionId;
  if(!port.current()||!future())return {state:'unknown'};
  try{const sent=await adapter.submit(post);if(sent.kind==='scheduled')receiptId=sent.receiptId;}catch{/* The platform might have accepted it. Inspect; never click again. */}
  if(!port.current())return {state:'unknown'};
  let observation:InspectionResult;
  try{observation=await adapter.inspect({receiptId,fingerprint:post.fingerprint});}catch{observation=unknown();}
  if(!port.current())return {state:'unknown'};
  const matched=observation.complete&&observation.accountExternalId===post.account.externalId&&observation.observedFingerprint===post.fingerprint&&(receiptId===null||observation.receiptId===receiptId||observation.state==='absent');
  // Preserve uncertainty even if an adapter accidentally returns another account's receipt.
  if(!matched)observation=unknown();
  const saved=await port.observe(submissionId,observation);
  if(!saved||!port.current())return {state:'unknown'};
  return {state:observation.state==='scheduled'||observation.state==='published'?observation.state:'unknown'};
 }catch{
  if(submissionId&&port.current()){try{await port.observe(submissionId,unknown());}catch{/* Durable server marker remains for restart inspection. */}}
  return markerAttempted?{state:'unknown'}:held('preparation_unavailable');
 }
}
/** Restart recovery never invokes submit. Cancellation targets only a fully matched receipt. */
export async function reconcileSocialPost(post:Pick<ApprovedPost,'account'|'fingerprint'>,input:{submissionId:string;receiptId:string|null;cancel:boolean},adapter:SocialAdapter,port:Pick<DeliveryPorts,'current'|'now'|'observe'>):Promise<{state:InspectionResult['state']}>{
 const unknown=():InspectionResult=>({state:'unknown',receiptId:null,permalink:null,observedAt:new Date(port.now()).toISOString(),accountExternalId:null,observedFingerprint:null,complete:false});
 const matches=(o:InspectionResult)=>o.complete&&o.accountExternalId===post.account.externalId&&o.observedFingerprint===post.fingerprint&&(input.receiptId===null||o.receiptId===input.receiptId||o.state==='absent');
 let observation=unknown();
 try{
  if(!port.current())return {state:'unknown'};
  const account=await adapter.inspectAccount();
  if(!port.current()||account?.externalId!==post.account.externalId||account.platform!==post.account.platform)return {state:'unknown'};
  observation=await adapter.inspect({receiptId:input.receiptId,fingerprint:post.fingerprint});
  if(!port.current())return {state:'unknown'};
  if(!matches(observation))observation=unknown();
  if(input.cancel&&observation.state==='scheduled'&&observation.receiptId){
   const again=await adapter.inspectAccount();
   if(!port.current()||again?.externalId!==post.account.externalId||again.platform!==post.account.platform)return {state:'unknown'};
   observation=await adapter.cancel(observation.receiptId);
   if(!matches(observation))observation=unknown();
  }
 }catch{observation=unknown();}
 if(!port.current())return {state:'unknown'};
 try{if(!await port.observe(input.submissionId,observation)||!port.current())return {state:'unknown'};}catch{return {state:'unknown'};}
 return {state:observation.state};
}
