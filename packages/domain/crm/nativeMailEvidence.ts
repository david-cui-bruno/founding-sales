import {readMailConversation,resolveMailSource,readMailSourceState,authorizeMailProcessing,revalidateMailProcessing,loadMailSourceInput,type CapturedMailProcessingAuthority,type MailCaptureProofVerifier} from '../mail/crmSources.ts';
import {crmClaimContextSchema} from '@fss/contracts';
import {unavailableMailEvidence,type CrmMailEvidencePort,type MailProcessingAuthority} from './mailEvidence.ts';
/** Actual native lineage owns copy authority; absent processing proof remains unavailable. */
export function createNativeCrmMailEvidence(verifier?:MailCaptureProofVerifier):CrmMailEvidencePort {
 const authorities=new WeakMap<MailProcessingAuthority,CapturedMailProcessingAuthority>();
 return {...unavailableMailEvidence,async revalidateProcessing(context,authority){const native=authorities.get(authority);return native!==undefined&&await revalidateMailProcessing(context,native,verifier);},async loadOriginalInput(context,authority){const native=authorities.get(authority);if(native===undefined)return null;const read=await loadMailSourceInput(context,native.exact,native,verifier);return read.state==='available'?JSON.stringify({text:read.text,representation:read.representation,completeness:read.completeness,ranges:read.ranges}):null;},readState:readMailSourceState,async authorizeProcessing(context,source,purposeOwner){
  if(source.workspaceId!==context.scope.workspaceId||source.kind!=='mail'||source.contentHash===null)return null;
  const checked=await authorizeMailProcessing(context,{sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash},purposeOwner,verifier);
  if(!checked.ok)return null;const authority={source,authorizationFingerprint:checked.authority.authorizationFingerprint,nativeAuthority:checked.authority};authorities.set(authority,checked.authority);return authority;
 },async readContext(context,source){
  if(source.workspaceId!==context.scope.workspaceId||source.kind!=='mail'||source.contentHash===null)return null;
  const read=await readMailConversation(context,{sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash});
  if(read.state!=='available')return null;
  const refs=[...read.source.originalContexts.map(cx=>({...cx,kind:'acquired' as const})),...read.source.reviewedContexts.map(cx=>({...cx,kind:'reviewed' as const}))];
  if(refs.length>100)return null;
  const people=[...new Set(refs.flatMap(cx=>cx.personId===null?[]:[cx.personId]))];
  const value={personId:people.length===1?people[0]:null,firmIds:[...new Set(refs.flatMap(cx=>cx.firmId===null?[]:[cx.firmId]))].sort(),relationships:[],review:people.length!==1||refs.some(cx=>cx.review==='review_required')?'required':'current',mailContexts:refs.map(cx=>({contextId:cx.contextId,sourceRevision:cx.sourceRevision,personId:cx.personId,firmId:cx.firmId,opportunityId:cx.opportunityId,operationalMatchId:cx.operationalMatchId,operationalMatchHash:cx.operationalMatchHash,kind:cx.kind}))};
  const parsed=crmClaimContextSchema.safeParse(value);return parsed.success?parsed.data:null;
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
