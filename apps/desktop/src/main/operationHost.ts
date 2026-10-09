import {firmListResponseSchema} from '@fss/contracts';
import {relationshipListSchema} from '@fss/contracts';
import {personPageSchema,peopleListSchema} from '@fss/contracts';
import {bookingCapacityResponseSchema} from '@fss/contracts';
import {outreachSenderStandingV2ResponseSchema} from '@fss/contracts';
import {actionableNotificationsResponseSchema,type NotificationRuntimeStatus} from '@fss/contracts';
import { todayActionsResponseSchema, todayActionOpenResponseSchema } from '@fss/contracts';
import type {SocialAccountsBridge} from './social/accountsBridge.ts';
import {socialWeeklySchema} from '@fss/contracts';
import {socialDraftWorkspaceSchema} from '@fss/contracts';
import type {SocialImageImport} from './social/imageImport.ts';
import {socialAssetViewSchema,socialAssetLibrarySchema,socialWorkspaceSchema} from '@fss/contracts';
import {outreachControlSchema,outreachSenderStandingResponseSchema,outreachCohortPreviewSchema} from '@fss/contracts';
import {callNeedViewSchema} from '@fss/contracts';
import {learningReportSchema,targetingViewSchema} from '@fss/contracts';
import {meetingQualificationViewSchema} from '@fss/contracts';
import {sourcingFeedbackSavedSchema} from '@fss/contracts';
import { qualificationViewSchema, qualificationQueuedSchema, qualificationAdmittedSchema } from '@fss/contracts';
import { candidateListSchema, candidateSavedSchema, candidateChangedSchema } from '@fss/contracts';
import { meetingRecordingSetupViewSchema } from '@fss/contracts';
import { meetingFollowThroughViewV2Schema } from '@fss/contracts';
import { meetingNotesRevisionSchema, meetingTaskViewSchema, meetingOutcomesViewSchema } from '@fss/contracts';
import {
  applyCallProposalsResultSchema,
  callLogsResponseSchema,
  correctCallOutcomeResultSchema,
  correctionPreviewResponseSchema,
  applyKeyReasonsSchema,
  callAnalysisResponseSchema,
  callRecapResponseSchema,
  proposalAcceptanceResponseSchema,
  callTrialResponseSchema,
  reviewListResponseSchema,
  firmBasicsRefusalSchema,
  firmBasicsResultSchema,
  firmMeetingsResponseSchema,
  firmRecordingsResponseSchema,
  meetingAttendanceSetSchema,
  meetingPreparationResponseSchema,
  loggedCallResultSchema,
  meetingMatchedSchema,
  unmatchedMeetingsResponseSchema,
} from '@fss/contracts';
import { z } from 'zod';
import {
  DIAL_IPC_CHANNELS,
  OPERATIONS,
  OPERATION_IPC_CHANNELS,
  OPERATION_NAMES,
  operationOf,
  type OperationInput,
  type OperationName,
} from '../shared/operations.ts';
import type { AuthedClient } from './authedClient.ts';
import type { BriefImportHost } from './briefImport.ts';
import { meetingTranscriptPageSchema, recordingRecoveriesSchema } from '@fss/contracts';
import type { RecordingImportHost } from './recordings/importer.ts';
import type { CrmBridgeHost } from './crmBridge.ts';
import type { MailboxBridgeHost } from './mailboxBridge.ts';
import type { ReplyBridgeHost } from './replyBridge.ts';
import type { ResearchBridgeHost } from './researchBridge.ts';
import type { SequenceBridgeHost } from './sequenceBridge.ts';
import type { AdminBridgeHost } from './settingsBridge.ts';
import type { TodayBridgeHost } from './todayBridge.ts';

/**
 * The main-process half of the operation registry (D4; specification 14.2).
 *
 * Two channels answer every operation the converted views can name, and each answer goes
 * through the same three steps: look the operation up in the closed list, parse the input
 * with that operation's schema, and parse what comes back with its output schema. A
 * renderer that asked for something outside the list, or with a shape outside it, never
 * reaches a handler at all.
 *
 * The transformations are not written here. Today's stale expansion and refusal eviction
 * are `todayBridge.ts`'s, the wall-clock callback resolved against the business zone is
 * `replyBridge.ts`'s, and both keep the in-memory state a view's next read depends on.
 * What this file does is say which operation is answered by which of them, once, in a
 * table a test walks — so an operation with no handler and a handler with no operation
 * are both a failing test rather than a channel that answers `undefined`.
 *
 * **Parsing on both sides is not paranoia about our own code.** It is what makes the
 * renderer's type a guarantee rather than a hope, and it means a state that grew a field
 * it should not have — a token, a `tel:` URI, a message body on a Today card — fails at
 * the boundary instead of reaching the page.
 */

export interface OperationHostDeps {
  readonly notifications?:{status():NotificationRuntimeStatus};
  readonly socialAccounts?: SocialAccountsBridge;
  readonly socialImages?: SocialImageImport;
  readonly api: AuthedClient;
  readonly today: TodayBridgeHost;
  readonly replies: ReplyBridgeHost;
  readonly research: ResearchBridgeHost;
  readonly crm: CrmBridgeHost;
  readonly sequences: SequenceBridgeHost;
  readonly settings: AdminBridgeHost;
  readonly mailbox: MailboxBridgeHost;
  /** Lane PB: the prepared-brief import the main process holds. */
  readonly briefImport: BriefImportHost;
  /** Lane M4: the demo recording import the main process holds. */
  readonly recordings: RecordingImportHost;
}

type Handler = (input: never) => Promise<unknown>;

/**
 * A malformed input is the view's current state back, not an argument passed on to the
 * API — the rule every hand-written channel followed before the registry existed. The
 * diagnostics operations have no such state, so their refusal is a rejected call the
 * form shows where the answer would have been.
 */
const FALLBACK: Readonly<Record<string, OperationName>> = Object.freeze({
  today: 'today.state',
  replies: 'replies.state',
  research: 'research.state',
  crm: 'crm.state',
  sequences: 'sequences.state',
  settings: 'settings.state',
  mailbox: 'mailbox.state',
  recordings: 'recordings.state',
});

/**
 * The per-key reasons of a refused Apply: the 409 body's `keyReasons`, `{ [proposalKey]: code }`
 * (`applyKeyReasonsSchema`). An Apply is atomic: one refused key refuses the batch and writes
 * nothing, and each key that was refused says why. A refusal that names no key (a freshness
 * refusal) carries none, and anything that does not parse is no per-key detail.
 */
export function keyReasonsOf(refusal: unknown): Record<string, string> {
  if (typeof refusal !== 'object' || refusal === null) return {};
  const parsed = applyKeyReasonsSchema.safeParse((refusal as { keyReasons?: unknown }).keyReasons);
  return parsed.success ? parsed.data : {};
}

async function readAnalysis(api: AuthedClient, callSessionId: string): Promise<{ analysis: z.infer<typeof callAnalysisResponseSchema> | null; reason: string | null }> {
  const answer = await api.read(`/calls/analysis?callSessionId=${encodeURIComponent(callSessionId)}`, value =>
    callAnalysisResponseSchema.parse(value),
  );
  return answer.ok ? { analysis: answer.value, reason: null } : { analysis: null, reason: answer.reason.slice(0, 80) };
}

export function operationHandlers(deps: OperationHostDeps): Readonly<Record<OperationName, Handler>> {
  const handlers = {
    'today.actions': async () => {
      const generation = deps.recordings.identity.current();
      const answer = await deps.api.read('/today/actions', value => todayActionsResponseSchema.parse(value));
      return generation === deps.recordings.identity.current() && answer.ok ? answer.value : null;
    },
    'today.openAction': async (input: OperationInput<'today.openAction'>) => {
      const generation = deps.recordings.identity.current();
      const answer = await deps.api.read('/today/actions/open', value => todayActionOpenResponseSchema.parse(value), input);
      return generation === deps.recordings.identity.current() && answer.ok ? answer.value : null;
    },
    'today.state': async () => await deps.today.state(),
    'today.refresh': async (input: { readonly quiet?: boolean }) =>
      await deps.today.refresh({ quiet: input.quiet === true }),
    'today.expand': async (input: { readonly firmId: string }) => await deps.today.expand(input),
    'today.collapse': async () => await deps.today.collapse(),
    'today.callsPlaced': async () => await deps.today.callsPlaced(),
    'today.snooze': async (input: Parameters<TodayBridgeHost['snooze']>[0]) => await deps.today.snooze(input),
    'today.previewFollowUp': async (input: Parameters<TodayBridgeHost['previewFollowUp']>[0]) =>
      await deps.today.previewFollowUp(input),
    'today.recordOutcome': async (input: Parameters<TodayBridgeHost['recordOutcome']>[0]) =>
      await deps.today.recordOutcome(input),
    'today.recordAgreedDates': async (input: Parameters<TodayBridgeHost['recordAgreedDates']>[0]) =>
      await deps.today.recordAgreedDates(input),
    'today.scheduleCallback': async (input: Parameters<TodayBridgeHost['scheduleCallback']>[0]) =>
      await deps.today.scheduleCallback(input),
    'today.releasePause': async (input: Parameters<TodayBridgeHost['releasePause']>[0]) =>
      await deps.today.releasePause(input),

    'calling.status': async (input: { readonly firmId: string }) => await deps.today.callingStatus(input),
    'calling.start': async (input: Parameters<TodayBridgeHost['startCall']>[0]) => await deps.today.startCall(input),
    'calling.cancel': async (input: Parameters<TodayBridgeHost['cancelCall']>[0]) => await deps.today.cancelCall(input),
    'calling.setActive': async (input: { readonly active: boolean }) => await deps.today.setCallActive(input),
    'calling.resume': async (input: { readonly firmId: string }) => await deps.today.resumeCalling(input),
    'calling.history': async (input: { readonly firmId: string }) => await deps.today.callHistory(input),
    'calling.recording': async (input: { readonly sessionId: string }) => await deps.today.callRecording(input),
    'calling.transcript': async (input: { readonly callSessionId: string }) => await deps.today.callTranscript(input),

    'replies.state': async () => await deps.replies.state(),
    'replies.refresh': async () => await deps.replies.refresh(),
    'replies.open': async (input: { readonly messageId: string }) => await deps.replies.open(input),
    'replies.collapse': async () => await deps.replies.collapse(),
    'replies.forget': async () => await deps.replies.forget(),
    'replies.confirm': async (input: Parameters<ReplyBridgeHost['confirm']>[0]) => await deps.replies.confirm(input),
    'replies.resolve': async (input: Parameters<ReplyBridgeHost['resolve']>[0]) => await deps.replies.resolve(input),

    'replies.model': async () => await deps.replies.model(),
    'replies.saveModel': async (input: Parameters<ReplyBridgeHost['saveModel']>[0]) =>
      await deps.replies.saveModel(input),

    'social.imageStage':async()=>deps.socialImages?deps.socialImages.state():{stage:null,reason:null,savedAssetId:null},
    'social.chooseImage':async(input:OperationInput<'social.chooseImage'>)=>deps.socialImages?deps.socialImages.choose(input):{stage:null,reason:'unavailable',savedAssetId:null},
    'social.pasteImage':async(input:OperationInput<'social.pasteImage'>)=>deps.socialImages?deps.socialImages.paste(input):{stage:null,reason:'unavailable',savedAssetId:null},
    'social.imageFromUrl':async(input:OperationInput<'social.imageFromUrl'>)=>deps.socialImages?deps.socialImages.fromUrl(input):{stage:null,reason:'unavailable',savedAssetId:null},
    'social.editImage':async(input:OperationInput<'social.editImage'>)=>deps.socialImages?deps.socialImages.edit(input):{stage:null,reason:'unavailable',savedAssetId:null},
    'social.uploadImage':async(input:OperationInput<'social.uploadImage'>)=>deps.socialImages?deps.socialImages.upload(input):{stage:null,reason:'unavailable',savedAssetId:null},
    'social.discardImage':async(input:OperationInput<'social.discardImage'>)=>deps.socialImages?deps.socialImages.discard(input):{stage:null,reason:'unavailable',savedAssetId:null},
    'social.thumbnail':async(input:OperationInput<'social.thumbnail'>)=>{
      const generation=deps.recordings.identity.current(),current=()=>generation===deps.recordings.identity.current();
      try{
        const answer=await deps.api.read('/social/assets/read',v=>z.strictObject({asset:socialAssetViewSchema}).parse(v),{assetId:input.assetId});
        if(!current()||!answer.ok)return {preview:null,reason:'image_unavailable'};
        const image=answer.value.asset.objects.find(row=>row.version===input.version&&row.kind==='derivative'&&row.state==='ready');
        if(!image)return {preview:null,reason:'image_unavailable'};
        const location=await deps.api.read('/social/assets/download-url',v=>z.strictObject({url:z.string().url(),expiresAt:z.string().datetime()}).parse(v),input);
        if(!current()||!location.ok)return {preview:null,reason:'image_unavailable'};
        const {fetchSocialThumbnail}=await import('./social/imageThumbnail.ts');
        const preview=await fetchSocialThumbnail(location.value,image);
        return current()?{preview,reason:null}:{preview:null,reason:'image_unavailable'};
      }catch{return {preview:null,reason:'image_unavailable'};}
    },
    'social.assets':async(input:OperationInput<'social.assets'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/social/assets',v=>socialAssetLibrarySchema.parse(v),input);if(generation!==deps.recordings.identity.current())return {assets:null,reason:'not_found'};return answer.ok?{assets:answer.value.assets,reason:null}:{assets:null,reason:answer.reason};},
    'social.removeAsset':async(input:OperationInput<'social.removeAsset'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/social/assets/delete',{assetId:input.assetId},v=>z.unknown().parse(v),{commandId:input.commandId});if(generation!==deps.recordings.identity.current())return {accepted:false,reason:'not_found'};return {accepted:answer.ok,reason:answer.ok?null:answer.reason};},
    'social.connectAccount':async(input:OperationInput<'social.connectAccount'>)=>deps.socialAccounts?deps.socialAccounts.connect(input):{accepted:false,reason:'unavailable'},
    'social.disconnectAccount':async(input:OperationInput<'social.disconnectAccount'>)=>deps.socialAccounts?deps.socialAccounts.disconnect(input):{accepted:false,reason:'unavailable'},
    'social.weekly':async()=>{const generation=deps.recordings.identity.current(),answer=await deps.api.read('/social/weekly',v=>socialWeeklySchema.parse(v),{});if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason};},
    'social.saveWeekly':async(input:OperationInput<'social.saveWeekly'>)=>{const generation=deps.recordings.identity.current(),{commandId,...setting}=input;const answer=await deps.api.command('/social/weekly/save',setting,v=>socialWeeklySchema.parse(v),{commandId});if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason};},
    'social.drafts':async()=>{const generation=deps.recordings.identity.current(),answer=await deps.api.read('/social/drafts',v=>socialDraftWorkspaceSchema.parse(v),{});if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason};},
    'social.requestDrafts':async(input:OperationInput<'social.requestDrafts'>)=>{const generation=deps.recordings.identity.current(),{commandId,...selection}=input;const answer=await deps.api.command('/social/drafts/request',selection,v=>z.strictObject({requestId:z.string().uuid()}).parse(v),{commandId});if(generation!==deps.recordings.identity.current())return {requestId:null,reason:'not_found'};return answer.ok?{requestId:answer.value.requestId,reason:null}:{requestId:null,reason:answer.reason};},
    'social.workspace':async()=>{const generation=deps.recordings.identity.current(),answer=await deps.api.read('/social',v=>socialWorkspaceSchema.parse(v),{});if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason};},
    'social.mutate':async(input:OperationInput<'social.mutate'>)=>{const generation=deps.recordings.identity.current();const {action,commandId,...payload}=input;const paths={save:'/social/posts/save',approve:'/social/posts/approve',cancel:'/social/posts/cancel'} as const;const answer=await deps.api.command(paths[action],payload,v=>z.unknown().parse(v),{commandId});if(generation!==deps.recordings.identity.current())return {accepted:false,view:null,reason:'not_found'};if(!answer.ok)return {accepted:false,view:null,reason:answer.reason};const view=await deps.api.read('/social',v=>socialWorkspaceSchema.parse(v),{});if(generation!==deps.recordings.identity.current())return {accepted:false,view:null,reason:'not_found'};return {accepted:true,view:view.ok?view.value:null,reason:view.ok?null:'refresh_failed'};},
    'notifications.read':async()=>{
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read('/notifications/actions',value=>actionableNotificationsResponseSchema.parse(value));
      if(generation!==deps.recordings.identity.current())return {ok:false,reason:'not_found',offline:false};
      return answer.ok?{ok:true,value:answer.value}:{ok:false,reason:answer.reason,offline:answer.offline};
    },
    'notifications.runtime':async()=>deps.notifications?.status()??{state:'stopped',lastCheckedAt:null},
    'replyComposer.context':async(input:OperationInput<'replyComposer.context'>)=>{
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read('/replies/composer/context',value=>replyDraftContextResultSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {ok:false,reason:'not_found'};
      return answer.ok?answer.value:{ok:false,reason:answer.reason};
    },
    'replyComposer.generate':async(input:OperationInput<'replyComposer.generate'>)=>{
      const generation=deps.recordings.identity.current(),{commandId,...payload}=input;
      const answer=await deps.api.command('/replies/composer/generate',payload,value=>replyDraftGenerateResultSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {ok:false,reason:'not_found'};
      return answer.ok?answer.value:{ok:false,reason:answer.reason};
    },
    'replyComposer.preview':async(input:OperationInput<'replyComposer.preview'>)=>{
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read('/replies/composer/preview',value=>humanReplyPreviewResultSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {ok:false,reason:'session_changed'};
      return answer.ok?answer.value:{ok:false,reason:answer.reason};
    },
    'replyComposer.sendStatus':async(input:OperationInput<'replyComposer.sendStatus'>)=>{
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read('/replies/composer/send-status',value=>humanReplySendResultSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {ok:false,reason:'session_changed'};
      return answer.ok?answer.value:{ok:false,reason:answer.reason};
    },
    'replyComposer.send':async(input:OperationInput<'replyComposer.send'>)=>{
      const generation=deps.recordings.identity.current(),{commandId,...payload}=input;
      const answer=await deps.api.command('/replies/composer/send',payload,value=>humanReplySendResultSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {ok:false,reason:'session_changed'};
      return answer.ok?answer.value:{ok:false,reason:answer.reason};
    },
    'outreach.control': async(input:OperationInput<'outreach.control'>)=>{
      const generation=deps.recordings.identity.current(),answer=await deps.api.read('/outreach/control/v2',value=>outreachControlSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'outreach.senderStandingV2':async(input:OperationInput<'outreach.senderStandingV2'>)=>{
      const generation=deps.recordings.identity.current(),answer=await deps.api.read('/outreach/senders/standing/v2',value=>outreachSenderStandingV2ResponseSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason};
    },
    'outreach.senderStanding': async(input:OperationInput<'outreach.senderStanding'>)=>{
      const generation=deps.recordings.identity.current(),answer=await deps.api.read('/outreach/senders/standing',value=>outreachSenderStandingResponseSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'outreach.preview': async(input:OperationInput<'outreach.preview'>)=>{
      const generation=deps.recordings.identity.current(),answer=await deps.api.read('/outreach/cohort/preview',value=>outreachCohortPreviewSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'outreach.mutate': async(input:OperationInput<'outreach.mutate'>)=>{
      const generation=deps.recordings.identity.current(),{action,commandId,...body}=input;
      const paths={email_admission:'/outreach/email-admission/save',authorization:'/outreach/authorization/save',policy:'/outreach/settings/save',fact_save:'/outreach/answer-blocks/save',fact_approve:'/outreach/answer-blocks/approve',fact_retire:'/outreach/answer-blocks/retire',cohort_enable:'/outreach/cohort/enable',reply_manual:'/outreach/reply/manual'} as const;
      const answer=await deps.api.command(paths[action],body,value=>z.record(z.string(),z.unknown()).parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {accepted:false,view:null,reason:'not_found'};
      if(!answer.ok)return {accepted:false,view:null,reason:answer.reason.slice(0,80)};
      const read=await deps.api.read('/outreach/control/v2',value=>outreachControlSchema.parse(value),{});
      if(generation!==deps.recordings.identity.current())return {accepted:false,view:null,reason:'not_found'};
      return {accepted:true,view:read.ok?read.value:null,reason:read.ok?null:'refresh_failed'};
    },
    'sourcing.callNeed': async(input:OperationInput<'sourcing.callNeed'>)=>{
      const generation=deps.recordings.identity.current();const answer=await deps.api.read('/sourcing/call-need',value=>callNeedViewSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.saveCallNeed': async(input:OperationInput<'sourcing.saveCallNeed'>)=>{
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;
      const answer=await deps.api.command('/sourcing/call-need/save',body,value=>z.object({revision:z.number().int().positive()}).parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {result:null,reason:'not_found'};
      return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.learning': async (input:OperationInput<'sourcing.learning'>)=>{
      const generation=deps.recordings.identity.current();const answer=await deps.api.read('/sourcing/learning/v2',value=>learningReportSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.targeting': async (input:OperationInput<'sourcing.targeting'>)=>{
      const generation=deps.recordings.identity.current();const answer=await deps.api.read('/sourcing/targeting',value=>targetingViewSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.proposeTargeting': async (input:OperationInput<'sourcing.proposeTargeting'>)=>{
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;const answer=await deps.api.command('/sourcing/targeting/save',body,value=>z.object({id:z.string().uuid(),revision:z.number().int().positive()}).parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {result:null,reason:'not_found'};
      return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.applyTargeting': async (input:OperationInput<'sourcing.applyTargeting'>)=>{
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;const answer=await deps.api.command('/sourcing/targeting/apply',body,value=>z.object({policyVersion:z.string()}).parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {result:null,reason:'not_found'};
      return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.feedback': async (input:OperationInput<'sourcing.feedback'>) => {
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;
      const answer=await deps.api.command('/sourcing/qualification/feedback',body,value=>sourcingFeedbackSavedSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {result:null,reason:'not_found'};
      return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.firmQualification': async (input:OperationInput<'sourcing.firmQualification'>) => {
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read('/sourcing/qualification/firm',value=>qualificationViewSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.qualification': async (input:OperationInput<'sourcing.qualification'>) => {
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read('/sourcing/qualification/read',value=>qualificationViewSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.qualify': async (input:OperationInput<'sourcing.qualify'>) => {
      const generation=deps.recordings.identity.current();
      const {commandId,...body}=input;
      const answer=await deps.api.command('/sourcing/qualification/request',body,value=>qualificationQueuedSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {result:null,reason:'not_found'};
      return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.admit': async (input:OperationInput<'sourcing.admit'>) => {
      const generation=deps.recordings.identity.current();
      const {commandId,...body}=input;
      const answer=await deps.api.command('/sourcing/qualification/admit',body,value=>qualificationAdmittedSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {result:null,reason:'not_found'};
      return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.list': async (input:OperationInput<'sourcing.list'>) => {
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read('/sourcing/candidates/list',value=>candidateListSchema.parse(value),input);
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.save': async (input:OperationInput<'sourcing.save'>) => {
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;
      const answer=await deps.api.command('/sourcing/candidates/save',body,value=>candidateSavedSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {result:null,reason:'not_found'};
      return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.review': async (input:OperationInput<'sourcing.review'>) => {
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;
      const answer=await deps.api.command('/sourcing/candidates/review',body,value=>candidateChangedSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {result:null,reason:'not_found'};
      return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.check': async (input:OperationInput<'sourcing.check'>) => {
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;
      const answer=await deps.api.command('/sourcing/candidates/check',body,value=>candidateChangedSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {result:null,reason:'not_found'};
      return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.delete': async (input:OperationInput<'sourcing.delete'>) => {
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;
      const answer=await deps.api.command('/sourcing/candidates/delete',body,value=>candidateChangedSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {result:null,reason:'not_found'};
      return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
    },
    'research.state': async () => await deps.research.state(),
    'research.open': async (input: { readonly firmId: string }) => await deps.research.open(input),
    'research.run': async (input: { readonly firmId: string }) => await deps.research.run(input),
    'research.addLink': async (input: Parameters<ResearchBridgeHost['addLink']>[0]) =>
      await deps.research.addLink(input),
    'research.saveSettings': async (input: Parameters<ResearchBridgeHost['saveSettings']>[0]) =>
      await deps.research.saveSettings(input),

    'crm.relationshipSave':async(input:OperationInput<'crm.relationshipSave'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/relationships/save',input,value=>OPERATIONS['crm.relationshipSave'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.relationshipCorrect':async(input:OperationInput<'crm.relationshipCorrect'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/relationships/correct',input,value=>OPERATIONS['crm.relationshipCorrect'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.relationshipFirms':async()=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/firms',value=>firmListResponseSchema.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.endpointList':async(input:OperationInput<'crm.endpointList'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/crm/endpoints/list',value=>OPERATIONS['crm.endpointList'].output.parse(value),input);if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.endpointMatch':async(input:OperationInput<'crm.endpointMatch'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/crm/endpoints/match',value=>OPERATIONS['crm.endpointMatch'].output.parse(value),input);if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.endpointClaim':async(input:OperationInput<'crm.endpointClaim'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/endpoints/claim',input,value=>OPERATIONS['crm.endpointClaim'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.endpointCorrect':async(input:OperationInput<'crm.endpointCorrect'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/endpoints/correct',input,value=>OPERATIONS['crm.endpointCorrect'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.firmSourceRead':async(input:OperationInput<'crm.firmSourceRead'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/crm/firm-sources/read',value=>OPERATIONS['crm.firmSourceRead'].output.parse(value),input);if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.firmSourceAdd':async(input:OperationInput<'crm.firmSourceAdd'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/firm-sources/add',input,value=>OPERATIONS['crm.firmSourceAdd'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.firmSourceDelete':async(input:OperationInput<'crm.firmSourceDelete'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/firm-sources/delete',input,value=>OPERATIONS['crm.firmSourceDelete'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.firmSourceRestore':async(input:OperationInput<'crm.firmSourceRestore'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/firm-sources/restore',input,value=>OPERATIONS['crm.firmSourceRestore'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.firmSourceRecapture':async(input:OperationInput<'crm.firmSourceRecapture'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/firm-sources/recapture',input,value=>OPERATIONS['crm.firmSourceRecapture'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.sourceContextRead':async(input:OperationInput<'crm.sourceContextRead'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/crm/relationships/context/read',value=>OPERATIONS['crm.sourceContextRead'].output.parse(value),input);if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.sourceContextSave':async(input:OperationInput<'crm.sourceContextSave'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/relationships/context/save',input,value=>OPERATIONS['crm.sourceContextSave'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.relationshipRead':async(input:OperationInput<'crm.relationshipRead'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/crm/relationships/read',value=>relationshipListSchema.parse(value),input);if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.selectedImportPreview': async(input:OperationInput<'crm.selectedImportPreview'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/crm/imports/preview',value=>OPERATIONS['crm.selectedImportPreview'].output.parse(value),input);if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.selectedImportRead': async(input:OperationInput<'crm.selectedImportRead'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/crm/imports/read',value=>OPERATIONS['crm.selectedImportRead'].output.parse(value),input);if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.selectedImportCommit': async(input:OperationInput<'crm.selectedImportCommit'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/imports/commit',input,value=>OPERATIONS['crm.selectedImportCommit'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.selectedImportCorrect': async(input:OperationInput<'crm.selectedImportCorrect'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/imports/correct',input,value=>OPERATIONS['crm.selectedImportCorrect'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.selectedImportDelete': async(input:OperationInput<'crm.selectedImportDelete'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/imports/delete',input,value=>OPERATIONS['crm.selectedImportDelete'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.selectedImportRestore': async(input:OperationInput<'crm.selectedImportRestore'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/imports/restore',input,value=>OPERATIONS['crm.selectedImportRestore'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.selectedImportRecapture': async(input:OperationInput<'crm.selectedImportRecapture'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/imports/recapture',input,value=>OPERATIONS['crm.selectedImportRecapture'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.personList': async (input:OperationInput<'crm.personList'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/crm/people/list',value=>peopleListSchema.parse(value),input);if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.personRead': async (input:OperationInput<'crm.personRead'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.read('/crm/people/read',value=>personPageSchema.parse(value),input);if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.personCreate': async (input:OperationInput<'crm.personCreate'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/people/create',input,value=>OPERATIONS['crm.personCreate'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.personSourceAdd': async (input:OperationInput<'crm.personSourceAdd'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/people/source/add',input,value=>OPERATIONS['crm.personSourceAdd'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.personSourceDelete': async (input:OperationInput<'crm.personSourceDelete'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/people/source/delete',input,value=>OPERATIONS['crm.personSourceDelete'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.personSourceRecapture': async (input:OperationInput<'crm.personSourceRecapture'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/people/source/recapture',input,value=>OPERATIONS['crm.personSourceRecapture'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.personSourceRestore': async (input:OperationInput<'crm.personSourceRestore'>)=>{const generation=deps.recordings.identity.current();const answer=await deps.api.command('/crm/people/source/restore',input,value=>OPERATIONS['crm.personSourceRestore'].output.parse(value));if(generation!==deps.recordings.identity.current())throw new Error('identity_changed');if(!answer.ok)throw new Error(answer.reason);return answer.value;},
    'crm.state': async () => await deps.crm.state(),
    'crm.openFirm': async (input: { readonly firmId: string }) => await deps.crm.openFirm(input),
    'crm.firmTimeline': async (input: { readonly firmId: string; readonly before: string }) => await deps.crm.firmTimeline(input),
    'crm.openPipeline': async (input?: Parameters<CrmBridgeHost['openPipeline']>[0]) => await deps.crm.openPipeline(input),
    'crm.openAddFirm': async () => await deps.crm.openAddFirm(),
    'crm.openImport': async () => await deps.crm.openImport(),
    'crm.addFirm': async (input: Parameters<CrmBridgeHost['addFirm']>[0]) => await deps.crm.addFirm(input),
    'crm.commitImport': async () => await deps.crm.commitImport(),
    'crm.saveContact': async (input: Parameters<CrmBridgeHost['saveContact']>[0]) => await deps.crm.saveContact(input),
    'crm.changeStage': async (input: Parameters<CrmBridgeHost['changeStage']>[0]) => await deps.crm.changeStage(input),
    'crm.setValue': async (input: Parameters<CrmBridgeHost['setValue']>[0]) => await deps.crm.setValue(input),
    'crm.resolveMerge': async (input: Parameters<CrmBridgeHost['resolveMerge']>[0]) => await deps.crm.resolveMerge(input),
    'crm.openOpportunity': async (input: OperationInput<'crm.openOpportunity'>) => await deps.crm.openOpportunity(input),
    'crm.takeOver': async input => await deps.crm.takeOver(input),
    'crm.resolveOutgoing': async (input: Parameters<CrmBridgeHost['resolveOutgoing']>[0]) =>
      await deps.crm.resolveOutgoing(input),
    'crm.enroll': async (input: Parameters<CrmBridgeHost['enroll']>[0]) => await deps.crm.enroll(input),
    'crm.checkRoute': async (input: Parameters<CrmBridgeHost['checkRoute']>[0]) => await deps.crm.checkRoute(input),

    'sequences.state': async () => await deps.sequences.state(),
    'sequences.openSequence': async (input: { readonly sequenceId: string }) => await deps.sequences.openSequence(input),
    'sequences.createSequence': async (input: { readonly name: string }) => await deps.sequences.createSequence(input),
    'sequences.saveSteps': async (input: Parameters<SequenceBridgeHost['saveSteps']>[0]) =>
      await deps.sequences.saveSteps(input),
    'sequences.saveTemplate': async (input: Parameters<SequenceBridgeHost['saveTemplate']>[0]) =>
      await deps.sequences.saveTemplate(input),
    'sequences.publish': async (input: { readonly sequenceVersionId: string }) => await deps.sequences.publish(input),
    'sequences.retire': async (input: { readonly sequenceVersionId: string }) => await deps.sequences.retire(input),

    'settings.state': async () => await deps.settings.state(),
    'settings.show': async (input: Parameters<AdminBridgeHost['show']>[0]) => await deps.settings.show(input),
    'settings.saveSetting': async (input: Parameters<AdminBridgeHost['saveSetting']>[0]) =>
      await deps.settings.saveSetting(input),
    'settings.saveIntegration': async (input: Parameters<AdminBridgeHost['saveIntegration']>[0]) =>
      await deps.settings.saveIntegration(input),
    'settings.openHistory': async (input: Parameters<AdminBridgeHost['openHistory']>[0]) =>
      await deps.settings.openHistory(input),
    'settings.loadDashboard': async (input: Parameters<AdminBridgeHost['loadDashboard']>[0]) =>
      await deps.settings.loadDashboard(input),
    'settings.retireStage': async (input: { readonly stageKey: string }) => await deps.settings.retireStage(input),
    'settings.acknowledgeAlert': async (input: { readonly alertId: string }) =>
      await deps.settings.acknowledgeAlert(input),
    'settings.setSendingCap': async (input: Parameters<AdminBridgeHost['setSendingCap']>[0]) =>
      await deps.settings.setSendingCap(input),
    'settings.recordSendingAuthentication': async (input: Parameters<AdminBridgeHost['recordSendingAuthentication']>[0]) =>
      await deps.settings.recordSendingAuthentication(input),
    'settings.recordHolidayCalendar': async (input: Parameters<AdminBridgeHost['recordHolidayCalendar']>[0]) =>
      await deps.settings.recordHolidayCalendar(input),
    'settings.addCallingNumber': async (input: Parameters<AdminBridgeHost['addCallingNumber']>[0]) =>
      await deps.settings.addCallingNumber(input),
    'settings.retireCallingNumber': async (input: { readonly identityId: string }) =>
      await deps.settings.retireCallingNumber(input),
    'settings.allowStates': async (input: Parameters<AdminBridgeHost['allowStates']>[0]) =>
      await deps.settings.allowStates(input),
    'settings.revokePosture': async (input: { readonly postureId: string }) => await deps.settings.revokePosture(input),

    'mailbox.state': async () => await deps.mailbox.state(),
    'mailbox.refresh': async () => await deps.mailbox.refresh(),
    'mailbox.connect': async () => await deps.mailbox.connect(),
    'mailbox.switch': async (input: { readonly switchTo: string }) => await deps.mailbox.switch(input),

    // Settings › Diagnostics. Straight through the authenticated client: there is no
    // state to keep and nothing to transform, and the recovery forms read the answer.
    'diagnostics.sendStatus': async (input: { readonly outboundMessageId: string }) => {
      const answer = await deps.api.read('/outbound/status', value => value, input);
      if (!answer.ok) throw new Error(answer.reason);
      return { fence: (answer.value as { fence?: unknown }).fence ?? null };
    },
    'diagnostics.resolveSend': async (input: { readonly outboundMessageId: string; readonly resolution: string }) => {
      const answer = await deps.api.command('/outbound/resolve', input, value => value);
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },
    'diagnostics.deadJobs': async () => {
      const answer = await deps.api.read('/admin/jobs/dead', value => value);
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },
    'diagnostics.requeueJob': async (input: { readonly jobId: string; readonly reason: string }) => {
      // Its own parser: this route predates the accepted envelope and answers a plain
      // body, which `AuthedClient.command` would read as a refusal.
      const answer = await deps.api.read('/admin/jobs/requeue', value => value, input);
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },

    // Slice 3a, lane C. Straight through the client, like Meetings: each answer is the value
    // or null/false with the server's code, so a route an API does not serve is a hidden
    // block and never an error page.
    'calling.analysis': async (input: { readonly callSessionId: string }) => await readAnalysis(deps.api, input.callSessionId),
    'calling.analysisRetry': async (input: OperationInput<'calling.analysisRetry'>) => {
      const answer = await deps.api.command('/calls/analysis/retry', input, value => value);
      if (!answer.ok) return { analysis: null, reason: answer.reason.slice(0, 80) };
      return await readAnalysis(deps.api, input.callSessionId);
    },
    'calling.analysisEdit': async (input: OperationInput<'calling.analysisEdit'>) => {
      const answer = await deps.api.command('/calls/analysis/edit', input, value => callAnalysisResponseSchema.parse(value));
      return answer.ok ? { analysis: answer.value, reason: null } : { analysis: null, reason: answer.reason.slice(0, 80) };
    },
    'calling.proposalsApply': async (input: OperationInput<'calling.proposalsApply'>) => {
      const { commandId, ...body } = input;
      const answer = await deps.api.command(
        '/calls/proposals/apply',
        body,
        value => applyCallProposalsResultSchema.parse(value),
        commandId === undefined ? {} : { commandId },
      );
      return answer.ok
        ? { applied: answer.value, reason: null, keyReasons: {} }
        : { applied: null, reason: answer.reason.slice(0, 80), keyReasons: answer.offline ? {} : keyReasonsOf(answer.refusal) };
    },
    'calling.proposalsDecline': async (input: OperationInput<'calling.proposalsDecline'>) => {
      const answer = await deps.api.command('/calls/proposals/decline', input, value => value);
      return { declined: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) };
    },
    'calling.pendingDismiss': async (input: OperationInput<'calling.pendingDismiss'>) => {
      const answer = await deps.api.command('/calls/pending/dismiss', input, value => value);
      return { dismissed: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) };
    },
    'calling.recap': async () => {
      const answer = await deps.api.read('/calls/recap', value => callRecapResponseSchema.parse(value));
      return { recap: answer.ok ? answer.value : null };
    },
    'calling.acceptance': async () => {
      const answer = await deps.api.read('/calls/proposals/acceptance', value => proposalAcceptanceResponseSchema.parse(value));
      return { acceptance: answer.ok ? answer.value : null };
    },
    'calling.trial': async () => {
      const answer = await deps.api.read('/calls/trial', value => callTrialResponseSchema.parse(value));
      return { trial: answer.ok ? answer.value : null };
    },
    'review.list': async () => {
      const answer = await deps.api.read('/review', value => reviewListResponseSchema.parse(value));
      if (answer.ok) return { items: answer.value.items, failed: false };
      // A 404 is an API that does not serve the list: the group hides. Anything else is a read
      // that did not answer, and the page keeps what it last knew.
      const notServed = !answer.offline && (answer.reason === 'not_found' || answer.reason === 'http_404');
      return { items: null, failed: !notServed };
    },
    'review.stageResolve': async (input: OperationInput<'review.stageResolve'>) => {
      const answer = await deps.api.command('/review/stage/resolve', input, value => value);
      return { resolved: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) };
    },
    'suppressions.firmStop': async (input: OperationInput<'suppressions.firmStop'>) => {
      // Scope firm, the firm, the source David's own "do not call" carries, and the channel
      // he chose (migration 0037: calls, or all contact). Nothing else.
      const answer = await deps.api.command(
        '/suppressions/record',
        {
          scope: 'firm',
          firmId: input.firmId,
          source: 'prospect_do_not_call',
          ...(input.channel === undefined ? {} : { channel: input.channel }),
        },
        value => value,
      );
      return { stopped: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) };
    },
    'today.completeTask': async (input: Parameters<TodayBridgeHost['completeTask']>[0]) => await deps.today.completeTask(input),

    // S3X lane X2. Straight through the client, like lane C: each answer is the value or null
    // with the server's code.
    'calling.logs': async (input: OperationInput<'calling.logs'>) => {
      const answer = await deps.api.read(`/calls?firmId=${encodeURIComponent(input.firmId)}&include=corrections`, value =>
        callLogsResponseSchema.parse(value),
      );
      return { calls: answer.ok ? answer.value.calls : null };
    },
    'calling.correctionPreview': async (input: OperationInput<'calling.correctionPreview'>) => {
      const answer = await deps.api.read('/calls/logs/correction-preview', value => correctionPreviewResponseSchema.parse(value), input);
      return answer.ok ? { preview: answer.value, reason: null } : { preview: null, reason: answer.reason.slice(0, 80) };
    },
    'calling.correctOutcome': async (input: OperationInput<'calling.correctOutcome'>) => {
      const { commandId, ...body } = input;
      const answer = await deps.api.command('/calls/logs/correct', body, value => correctCallOutcomeResultSchema.parse(value), { commandId });
      return answer.ok ? { corrected: answer.value, reason: null } : { corrected: null, reason: answer.reason.slice(0, 80) };
    },
    'suppressions.supersede': async (input: OperationInput<'suppressions.supersede'>) => {
      // The unchanged admin supersession, for the one stop David confirmed (DESIGN-S3X §3.4a).
      const answer = await deps.api.command('/suppressions/supersede', { eventId: input.eventId, reason: 'correction' }, value => value, {
        commandId: input.commandId,
      });
      return { lifted: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) };
    },

    // Meetings (slice M1). Straight through the authenticated client, like Diagnostics.
    'meetings.bookingCapacity':async()=>{
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read('/meetings/booking-capacity',value=>bookingCapacityResponseSchema.parse(value));
      return {capacity:generation===deps.recordings.identity.current()&&answer.ok?answer.value:null};
    },
    'meetings.forFirm': async (input: { readonly firmId: string }) => {
      const answer = await deps.api.read(`/meetings/firm?firmId=${encodeURIComponent(input.firmId)}`, value =>
        firmMeetingsResponseSchema.parse(value),
      );
      return answer.ok
        ? { meetings: answer.value.meetings, stageSuggestion: answer.value.stageSuggestion ?? null }
        : { meetings: null, stageSuggestion: null };
    },
    // Lane M1: attendance, under the renderer's command id (a retry is the same command).
    'meetings.setAttendance': async (input: OperationInput<'meetings.setAttendance'>) => {
      const { commandId, ...body } = input;
      const answer = await deps.api.command('/meetings/attendance', body, value => meetingAttendanceSetSchema.parse(value), { commandId });
      return answer.ok ? { set: answer.value, reason: null } : { set: null, reason: answer.reason.slice(0, 80) };
    },
    // Lane M2: the meeting brief; a refusal or a lost answer is a reason, never an empty brief.
    'meetings.recordingSetup': async(input:OperationInput<'meetings.recordingSetup'>)=>{
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read(`/meetings/recording-setup?meetingId=${encodeURIComponent(input.meetingId)}`,value=>meetingRecordingSetupViewSchema.parse(value));
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'meetings.retryRecordingSetup': async(input:OperationInput<'meetings.retryRecordingSetup'>)=>{
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;
      const answer=await deps.api.command('/meetings/recording-setup/retry',body,value=>meetingRecordingSetupViewSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'meetings.followThrough': async (input:OperationInput<'meetings.followThrough'>) => {
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read(`/meetings/follow-through?meetingId=${encodeURIComponent(input.meetingId)}&version=2`,value=>meetingFollowThroughViewV2Schema.parse(value));
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'meetings.editRecap': async (input:OperationInput<'meetings.editRecap'>) => {
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;
      const answer=await deps.api.command('/meetings/recap/edit?version=2',body,value=>meetingFollowThroughViewV2Schema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'meetings.qualification': async (input:OperationInput<'meetings.qualification'>)=>{
      const generation=deps.recordings.identity.current();
      const answer=await deps.api.read(`/meetings/qualification?meetingId=${encodeURIComponent(input.meetingId)}`,value=>meetingQualificationViewSchema.parse(value));
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'meetings.saveQualification': async (input:OperationInput<'meetings.saveQualification'>)=>{
      const generation=deps.recordings.identity.current(),{commandId,...body}=input;
      const answer=await deps.api.command('/meetings/qualification/save',body,value=>meetingQualificationViewSchema.parse(value),{commandId});
      if(generation!==deps.recordings.identity.current())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'meetings.outcomes': async (input: OperationInput<'meetings.outcomes'>) => {
      const generation = deps.recordings.identity.current();
      const answer = await deps.api.read(`/meetings/outcomes?meetingId=${encodeURIComponent(input.meetingId)}`, value => meetingOutcomesViewSchema.parse(value));
      if (generation !== deps.recordings.identity.current()) return { view: null, reason: 'not_found' };
      return answer.ok ? { view: answer.value, reason: null } : { view: null, reason: answer.reason.slice(0,80) };
    },
    'meetings.saveNotes': async (input: OperationInput<'meetings.saveNotes'>) => {
      const generation = deps.recordings.identity.current(), { commandId, ...body } = input;
      const answer = await deps.api.command('/meetings/notes', body, value => meetingNotesRevisionSchema.parse(value), { commandId });
      if (generation !== deps.recordings.identity.current()) return { notes: null, reason: 'not_found' };
      return answer.ok ? { notes: answer.value, reason: null } : { notes: null, reason: answer.reason.slice(0,80) };
    },
    'meetings.changeTask': async (input: OperationInput<'meetings.changeTask'>) => {
      const generation = deps.recordings.identity.current(), { commandId, ...body } = input;
      const answer = await deps.api.command('/meetings/tasks/change', body, value => meetingTaskViewSchema.parse(value), { commandId });
      if (generation !== deps.recordings.identity.current()) return { task: null, reason: 'not_found' };
      return answer.ok ? { task: answer.value, reason: null } : { task: null, reason: answer.reason.slice(0,80) };
    },
    'meetings.brief': async (input: { readonly meetingId: string }) => {
      const generation = deps.recordings.identity.current();
      const answer = await deps.api.read(`/meetings/brief?meetingId=${encodeURIComponent(input.meetingId)}&include=meeting_tasks&version=2`, value =>
        meetingPreparationResponseSchema.parse(value),
      );
      if (generation !== deps.recordings.identity.current()) return { brief: null, reason: 'not_found' };
      return answer.ok ? { brief: answer.value, reason: null } : { brief: null, reason: answer.reason.slice(0, 80) };
    },
    'meetings.unmatched': async () => {
      const answer = await deps.api.read('/meetings/unmatched', value => unmatchedMeetingsResponseSchema.parse(value));
      return { meetings: answer.ok ? answer.value.meetings : null };
    },
    'meetings.match': async (input: { readonly meetingId: string; readonly firmId: string }) => {
      const answer = await deps.api.command('/meetings/match', input, value => meetingMatchedSchema.parse(value));
      return answer.ok ? { matched: answer.value, reason: null } : { matched: null, reason: answer.reason.slice(0, 80) };
    },

    // Slice S2. Straight through the authenticated client, like Meetings: the view that
    // asked reads its own state again afterwards.
    'firms.saveBasics': async (input: OperationInput<'firms.saveBasics'>) => {
      const answer = await deps.api.command('/crm/firms/basics', input, value => firmBasicsResultSchema.parse(value));
      if (answer.ok) return { saved: answer.value, reason: null, issues: [] };
      const refusal = answer.offline ? null : firmBasicsRefusalSchema.safeParse(answer.refusal);
      return {
        saved: null,
        reason: answer.reason.slice(0, 80),
        issues: refusal?.success === true ? (refusal.data.issues ?? []) : [],
      };
    },
    // Lane PB. Straight through the client, like the basics: the view reads its own state again.
    'firms.briefImportState': async () => await deps.briefImport.state(),
    'firms.briefImportCommit': async (input: OperationInput<'firms.briefImportCommit'>) => await deps.briefImport.commit(input),
    'firms.briefImportReset': async () => await deps.briefImport.reset(),
    // Lane M4: answered from the import the main process holds.
    'meetings.transcript': async (input: OperationInput<'meetings.transcript'>) => {
      const generation = deps.recordings.identity.current();
      const query = new URLSearchParams({ meetingId: input.meetingId, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
      const answer = await deps.api.read(`/meetings/transcript?${query.toString()}`, value => meetingTranscriptPageSchema.parse(value));
      if (generation !== deps.recordings.identity.current()) return { page: null, reason: 'not_found' };
      return answer.ok ? { page: answer.value, reason: null } : { page: null, reason: answer.reason };
    },
    'recordings.recoveries': async () => {
      const generation = deps.recordings.identity.current();
      const answer = await deps.api.read('/meetings/recordings/recovery', value => recordingRecoveriesSchema.parse(value));
      return generation === deps.recordings.identity.current() && answer.ok ? answer.value : { items: null, truncated: false };
    },
    'recordings.reupload': async (input: OperationInput<'recordings.reupload'>) => await deps.recordings.reupload(input),
    'recordings.state': async () => await deps.recordings.state(),
    'recordings.chooseMeeting': async (input: OperationInput<'recordings.chooseMeeting'>) => await deps.recordings.chooseMeeting(input),
    'recordings.ignore': async (input: OperationInput<'recordings.ignore'>) => await deps.recordings.ignore(input),
    'recordings.retry': async (input: OperationInput<'recordings.retry'>) => await deps.recordings.retry(input),
    'recordings.forFirm': async (input: OperationInput<'recordings.forFirm'>) => {
      const answer = await deps.api.read(`/meetings/recordings?firmId=${encodeURIComponent(input.firmId)}`, value => firmRecordingsResponseSchema.parse(value));
      return answer.ok ? { recordings: answer.value.recordings, truncated: answer.value.truncated } : { recordings: null, truncated: false };
    },
    'calls.logIncoming': async (input: OperationInput<'calls.logIncoming'>) => {
      const answer = await deps.api.command(
        '/calls/log',
        {
          firmId: input.firmId,
          ...(input.contactId === null ? {} : { contactId: input.contactId }),
          outcome: input.outcome,
          direction: 'inbound',
          occurredAt: input.occurredAt,
          ...(input.durationSeconds === null ? {} : { durationSeconds: input.durationSeconds }),
          ...(input.note.trim() === '' ? {} : { note: input.note.trim() }),
        },
        value => loggedCallResultSchema.parse(value),
      );
      if (!answer.ok) return { logged: false, reason: answer.reason.slice(0, 80) };
      const needsTime = answer.value.followUps.some(entry => entry.kind === 'callback_time_needed');
      return { logged: true, reason: needsTime ? 'outcome_recorded_callback_time_needed' : null };
    },
  } satisfies Readonly<Record<OperationName, (input: never) => Promise<unknown>>>;
  return handlers as Readonly<Record<OperationName, Handler>>;
}

/** Answer one operation: the closed list, then its input schema, then its output schema. */
export async function answerOperation(
  handlers: Readonly<Record<OperationName, Handler>>,
  kind: 'read' | 'command',
  name: unknown,
  input: unknown,
): Promise<unknown> {
  const operation = operationOf(name);
  if (operation === null) throw new Error('no such operation');
  const declared = OPERATIONS[operation];
  if (declared.kind !== kind) throw new Error(`${operation} is a ${declared.kind}, not a ${kind}`);

  const parsed = declared.input.safeParse(input ?? {});
  if (!parsed.success) {
    // The model setting answers its own shape, not the lane's: a malformed save reads it back.
    const fallback = operation === 'replies.saveModel' ? 'replies.model' : FALLBACK[operation.slice(0, operation.indexOf('.'))];
    if (fallback === undefined) throw new Error(`${operation} was asked for with a shape it does not accept`);
    return declared.output.parse(await handlers[fallback](undefined as never));
  }
  return declared.output.parse(await handlers[operation](parsed.data as never));
}

export interface OperationRegistration {
  readonly handlers: Readonly<Record<OperationName, Handler>>;
  readonly channels: readonly string[];
}

/**
 * Register the two channels. `handle` is passed in rather than `ipcMain` being imported,
 * for the reason every other module in this directory gives: importing Electron outside
 * the app downloads its binary in the middle of `vitest`.
 */
export function registerOperations(
  deps: OperationHostDeps,
  handle: (channel: string, listener: (argument: unknown) => Promise<unknown>) => void,
): OperationRegistration {
  const handlers = operationHandlers(deps);
  handle(OPERATION_IPC_CHANNELS.read, async argument => {
    const request = argument as { operation?: unknown; input?: unknown } | null;
    return await answerOperation(handlers, 'read', request?.operation, request?.input);
  });
  handle(OPERATION_IPC_CHANNELS.command, async argument => {
    const request = argument as { operation?: unknown; input?: unknown } | null;
    return await answerOperation(handlers, 'command', request?.operation, request?.input);
  });
  return { handlers, channels: [OPERATION_IPC_CHANNELS.read, OPERATION_IPC_CHANNELS.command] };
}

/** Every operation the registry declares has a handler, and no handler has no operation. */
export function operationCoverage(handlers: Readonly<Record<string, Handler>>): {
  readonly missing: readonly string[];
  readonly extra: readonly string[];
} {
  const named = new Set<string>(OPERATION_NAMES);
  const implemented = new Set(Object.keys(handlers));
  return {
    missing: [...named].filter(name => !implemented.has(name)),
    extra: [...implemented].filter(name => !named.has(name)),
  };
}

export { DIAL_IPC_CHANNELS, OPERATION_IPC_CHANNELS };
import {replyDraftContextResultSchema,replyDraftGenerateResultSchema} from '@fss/contracts';
import {humanReplyPreviewResultSchema,humanReplySendResultSchema} from '@fss/contracts';
