import {snapshotMailProcessingSourceContexts,readMailConversation,resolveMailSource,readMailSourceState,prepareMailProcessingAuthority,revalidatePreparedMailProcessing,loadPreparedMailSourceInput,type CapturedMailProcessingAuthority,type MailCaptureProofVerifier} from '../mail/crmSources.ts';
import {crmClaimContextSchema,mailConversationSchema} from '@fss/contracts';
import {unavailableMailEvidence,type CrmMailEvidencePort,type MailProcessingAuthority} from './mailEvidence.ts';
interface NativeContextInput {contextId:string;sourceRevision:number;personId:string|null;firmId:string|null;opportunityId:string|null;operationalMatchId:string|null;operationalMatchHash:string|null;review:string;contextKind:string}
/** One conversion keeps scheduler hints and locked worker context hashes identical. */
function processingContext(refs:readonly NativeContextInput[]){
 if(refs.length>100)return null;
 const people=[...new Set(refs.flatMap(cx=>cx.personId===null?[]:[cx.personId]))];
 const parsed=crmClaimContextSchema.safeParse({personId:people.length===1?people[0]:null,firmIds:[...new Set(refs.flatMap(cx=>cx.firmId===null?[]:[cx.firmId]))].sort(),relationships:[],review:people.length!==1||refs.some(cx=>cx.review==='review_required')?'required':'current',mailContexts:refs.map(cx=>({contextId:cx.contextId,sourceRevision:cx.sourceRevision,personId:cx.personId,firmId:cx.firmId,opportunityId:cx.opportunityId,operationalMatchId:cx.operationalMatchId,operationalMatchHash:cx.operationalMatchHash,kind:cx.contextKind}))});
 return parsed.success?parsed.data:null;
}
/** Actual native lineage owns copy authority; absent processing proof remains unavailable. */
export function createNativeCrmMailEvidence(verifier?:MailCaptureProofVerifier):CrmMailEvidencePort {
 const authorities=new WeakMap<MailProcessingAuthority,CapturedMailProcessingAuthority>();
 const verified=new WeakSet<MailProcessingAuthority>();
 return {...unavailableMailEvidence,async snapshotProcessing(context,source,purposeOwner){
  if(verifier===undefined||source.kind!=='mail'||source.contentHash===null||source.workspaceId!==context.scope.workspaceId)return null;
  const hint=await snapshotMailProcessingSourceContexts(context,{sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash},purposeOwner);
  if(!hint.ok)return null;
  const converted=processingContext(hint.contexts);
  return converted===null?null:{authorizationFingerprint:hint.authority.authorizationFingerprint,context:converted};
 },async prepareProcessing(context,source,purposeOwner){
  if(verifier===undefined||source.workspaceId!==context.scope.workspaceId||source.kind!=='mail'||source.contentHash===null)return null;
  const prepared=await prepareMailProcessingAuthority(context,{sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash},purposeOwner);
  if(!prepared.ok)return null;
  const authority={source,authorizationFingerprint:prepared.authority.authorizationFingerprint,nativeAuthority:prepared.authority};authorities.set(authority,prepared.authority);return authority;
 },async revalidatePrepared(context,authority){const native=authorities.get(authority);return native!==undefined&&await revalidatePreparedMailProcessing(context,native);},async loadOriginalInput(context,authority){const native=authorities.get(authority);if(native===undefined||!verified.has(authority))return null;const read=await loadPreparedMailSourceInput(context,native.exact,native);return read.state==='available'?JSON.stringify({text:read.text,representation:read.representation,completeness:read.completeness,ranges:read.ranges}):null;},readState:readMailSourceState,async authorizeProcessing(context,source,purposeOwner){
  if(source.workspaceId!==context.scope.workspaceId||source.kind!=='mail'||source.contentHash===null)return null;
  if(verifier===undefined)return null;
  const exact={sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash};
  const before=await prepareMailProcessingAuthority(context,exact,purposeOwner);
  if(!before.ok||!await verifier.verify(before.authority.proof))return null;
  const checked=await prepareMailProcessingAuthority(context,exact,purposeOwner);
  if(!checked.ok||checked.authority.authorizationFingerprint!==before.authority.authorizationFingerprint)return null;
  const authority={source,authorizationFingerprint:checked.authority.authorizationFingerprint,nativeAuthority:checked.authority};authorities.set(authority,checked.authority);verified.add(authority);return authority;
 },async readContext(context,source){
  if(source.workspaceId!==context.scope.workspaceId||source.kind!=='mail'||source.contentHash===null)return null;
  const read=await readMailConversation(context,{sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash});
  if(read.state!=='available')return null;
  return processingContext([...read.source.originalContexts.map(cx=>({...cx,contextKind:'acquired'})),...read.source.reviewedContexts.map(cx=>({...cx,contextKind:'reviewed'}))]);
 },async resolveCommitmentProof(context,source){
  if(source.kind!=='mail'||source.workspaceId!==context.scope.workspaceId||source.contentHash===null||source.locator===null)return null;
  const exact={sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash};
  const parsed=mailConversationSchema.safeParse(await readMailConversation(context,exact));if(!parsed.success)return null;
  const read=parsed.data;
  if(read.state!=='available'||read.source.direction!=='outgoing'||!read.source.sentProof||read.source.completeness!=='complete'||read.source.representation!=='plain_text'||read.source.passage===null)return null;
  const range=/^text:(0|[1-9]\d*):(0|[1-9]\d*)$/u.exec(source.locator);if(range===null)return null;
  const start=Number(range[1]),end=Number(range[2]);
  if(!read.source.ranges.some(part=>part.kind==='authored'&&part.start<=start&&part.end>=end))return null;
  const cited=await resolveMailSource(context,{...exact,locator:source.locator});if(cited.state!=='available'||cited.source.passage===null)return null;
  return {ownerUserId:read.source.ownerUserId,sourceRevision:read.source.sourceRevision,sourceHash:read.source.contentHash,providerEventAt:read.source.occurredAt,observedAt:read.source.observedAt,authored:true,actualOutgoing:true,passage:cited.source.passage};
 },async resolve(context,source){
  if(source.workspaceId!==context.scope.workspaceId||source.kind!=='mail'||source.contentHash===null)return null;
  const exact={sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash};
  const original=await readMailConversation(context,exact);
  if(original.state!=='available'||original.source.passage===null)return null;
  const copy=original.source;
  const cited=source.locator===null?null:await resolveMailSource(context,{...exact,locator:source.locator});
  if(source.locator!==null&&(cited?.state!=='available'||cited.source.passage===null))return null;
  return {source:{workspaceId:context.scope.workspaceId,sourceId:copy.sourceId,kind:'mail',revision:copy.sourceRevision,contentHash:copy.contentHash,locator:source.locator,speaker:null,occurredAt:copy.occurredAt,observedAt:copy.observedAt,completeness:copy.completeness==='complete'?'complete':'partial',availability:'available'},ownerUserId:copy.ownerUserId,extent:{unit:'utf16',length:copy.passage!.length},passage:cited?.state==='available'&&cited.source.passage!==null?{text:cited.source.passage,locator:cited.source.locator,speaker:null}:null};
 }};
}
