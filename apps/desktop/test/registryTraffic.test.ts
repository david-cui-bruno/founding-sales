import {createSocialDeliveryRunner} from '../src/main/social/deliveryRunner.ts';
import {createSocialManualHandoffBridge} from '../src/main/social/manualHandoffBridge.ts';
import {createSocialAccountsBridge} from '../src/main/social/accountsBridge.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {createSocialImageImport} from '../src/main/social/imageImport.ts';
import { describe, expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createBriefImport } from '../src/main/briefImport.ts';
import { createRecordingImporter } from '../src/main/recordings/importer.ts';
import { memoryRecordingStore } from '../src/main/recordings/store.ts';
import { createCrmBridge } from '../src/main/crmBridge.ts';
import { createMailboxBridge } from '../src/main/mailboxBridge.ts';
import { createReplyBridge } from '../src/main/replyBridge.ts';
import { createResearchBridge } from '../src/main/researchBridge.ts';
import { createSequenceBridge } from '../src/main/sequenceBridge.ts';
import { createAdminBridge } from '../src/main/settingsBridge.ts';
import { createTodayBridge } from '../src/main/todayBridge.ts';
import { createDialHandoff } from '../src/main/dialHandoff.ts';
import { operationHandlers, type OperationHostDeps } from '../src/main/operationHost.ts';
import { OPERATIONS, OPERATION_NAMES, type OperationName } from '../src/shared/operations.ts';
import { BRIDGE_ANSWERS, FIXTURE_IDS, STALE_CALL_LOG_ID } from './support/bridgeAnswers.ts';

/**
 * Every request a bridge makes is declared in the registry (1.0.13, P1-5).
 *
 * `Operation.calls` is what `operations.test.ts` reads to say that no deprecated route
 * has a caller left. That claim is only worth what the list is worth: a `calls` entry
 * written by hand can miss a path — Today's expansion and the Replies refresh each made
 * a call nobody had written down — or name one the bridge does not really ask for, and
 * the deprecated-route check would then be a check of a document rather than of the app.
 *
 * So this drives every operation's own host method against a recording client and
 * compares what actually went out with what the registry says. The query string counts:
 * the settings read is `/settings?include=postal_address`, and a registry that said
 * `/settings` would be describing the request the *previous* build made.
 *
 * The stub answers everything, and badly: a 200 whose body no schema accepts. That is
 * deliberate. What is being recorded is which requests a method makes, and a bridge that
 * only made its second call on a well-shaped first answer would hide that call from this
 * check — so the answers are uniform and the branches that do depend on a good answer are
 * the business of each bridge's own suite.
 *
 * No real person, firm or profile appears. `example.test` is reserved by RFC 6761.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const MANUAL_HANDOFF={postId:UUID,revision:1,fingerprint:'a'.repeat(64),approvalId:UUID,approvedAt:'2026-10-09T00:00:00Z',state:'manual_needed',accountEvidence:'human_review_required',snapshot:{account:{id:UUID,platform:'x',externalId:'example',displayName:'Example',accountKind:'profile',revision:1},text:'Reviewed example.',images:[],publishAt:'2030-10-19T16:00:00Z',zone:'America/New_York'}};


/** One request as the registry writes it: the method and the path with its query. */
function requestsOf(): { readonly seen: string[]; readonly api: ReturnType<typeof createAuthedClient> } {
  const seen: string[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.13',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const at = new URL(url);
      // An identifier in the query is the registry's `{uuid}` (slice C1's call reads).
      const search = at.search.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '{uuid}');
      seen.push(`${init.method} ${at.pathname}${search}`);
      /*
       * A body the bridge accepts wherever `support/bridgeAnswers.ts` has one, and an
       * empty accepted envelope otherwise.
       *
       * The answers matter (P1-5). A bridge that only makes its *second* call on a
       * well-shaped first answer would otherwise never make it here, and the registry
       * would be compared with the traffic of a refused app rather than a working one:
       * that is how `today.expand`'s `/dial/check` and `replies.refresh`'s
       * `/replies/settings` stayed undeclared through the first review.
       */
      const body = at.pathname==='/social/manual-handoff/read'?{view:MANUAL_HANDOFF}:at.pathname==='/social/manual-handoff/confirm'?{status:'accepted',replayed:false,result:{approvalId:UUID}}:BRIDGE_ANSWERS[at.pathname];
      return await Promise.resolve({
        status: 200,
        body: body ?? { status: 'accepted', replayed: false, result: {} },
      });
    },
  });
  return { seen, api };
}

/**
 * The session as the main process holds it. `today` carries a business zone because
 * Today's snooze and callback resolve a wall clock against it and refuse without one —
 * a session with no list would stop those two before they reached the server, and hide
 * their calls from this check.
 */
const held = {
  online: true,
  stale: false,
  asOf: null,
  mayMutate: true,
  device: { role: 'admin' as const },
  today: { snapshotDate: '2026-09-21', businessTimeZone: 'America/New_York', cards: [] },
};

const session = {
  state: async () => await Promise.resolve(held),
  refreshToday: async () => await Promise.resolve(held),
};

/** One call of every operation, with an input its schema accepts. */
const INPUTS: Readonly<Partial<Record<OperationName, unknown>>> = Object.freeze({
  'social.manualHandoff':{postId:UUID,expectedRevision:1},
  'social.confirmHandoff':{postId:UUID,expectedRevision:1,fingerprint:'a'.repeat(64),reviewedDestination:true,commandId:UUID},
  'social.useHandoff':{postId:UUID,expectedRevision:1,fingerprint:'a'.repeat(64),approvalId:UUID,action:'copy'},
  'social.registerManualDestination':{accountId:UUID,commandId:UUID,platform:'x',externalId:'example',displayName:'Example',accountKind:'profile'},
  'social.deliveryStatus':{},
  'sourcing.experiments':{},
  'sourcing.saveExperiment':{commandId:UUID,expectedRevision:0,status:'accepted',content:{change:{kind:'discovery_query',basePolicyVersion:'v1',queryId:'query',query:'Example property management'},interval:{from:'2026-10-01T00:00:00Z',to:'2026-10-09T00:00:00Z',asOf:'2026-10-09T00:00:00Z'},rationale:'Review an example.',counterexamples:[],uncertainty:'Unknown.',successMeasures:['Supported prospects.']}},
  'sourcing.activateExperiment':{commandId:UUID,id:UUID,expectedRevision:1,targetingDecision:true},
  'sourcing.stopExperiment':{commandId:UUID,activationId:UUID,reason:'Stop the example.'},
  'sourcing.eraseExperiment':{commandId:UUID,id:UUID,expectedRevision:1},
  'ask.read':{operation:'records',query:'Example',kind:'people',limit:20},
  'ask.answerRequest':{question:'Why?',scope:{sources:[{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null}]}},
  'ask.actionRead':{scope:{kind:'today'},limit:20},
  'ask.actionChange':{actionId:UUID,expectedVersion:1,action:'complete_task'},
  'ask.actionCreate':{requestId:UUID,expectedVersion:1,finding:{kind:'answer_claim',index:0},action:{kind:'preference',text:'Prefer weekday planning calls.'}},
  'ask.historyChange':{requestId:UUID,expectedRevision:1,action:{kind:'pin',pinned:true}},
  'ask.historyList':{limit:20},
  'ask.answerRead':{requestId:UUID},
  'ask.answerSourceRead':{requestId:UUID,expectedVersion:1,windowId:UUID},
  'crm.businessMailList': {limit:50},
  'crm.businessMailReadV2': {sourceId:UUID,sourceRevision:1,contentHash:'a'.repeat(64)},
  'crm.businessMailImportHealth':{mailboxId:UUID},
  'crm.businessMailImportRequest':{mailboxId:UUID},
  'crm.businessMailRead': {sourceId:UUID,sourceRevision:1,contentHash:'a'.repeat(64)},
  'crm.businessMailState': {sourceId:UUID},
  'crm.businessMailControls': {mailboxId:UUID},
  'crm.businessMailDelete': {sourceId:UUID,expectedRevision:1},
  'crm.businessMailRestore': {sourceId:UUID,expectedRevision:2},
  'crm.businessMailRecapture': {sourceId:UUID,expectedRevision:3},
  'crm.businessMailAssociate': {sourceId:UUID,expectedRevision:1,personId:UUID},
  'replyComposer.context':{messageId:UUID},
  'replyComposer.generate':{messageId:UUID,commandId:UUID,sourceRevision:'a'.repeat(64),factRefs:[],envelope:{to:['recipient@example.test'],cc:[]}},
  'replyComposer.preview':{messageId:UUID,text:'Tuesday works.',factRefs:[],envelope:{to:['recipient@example.test'],cc:[]}},
  'replyComposer.sendStatus':{messageId:UUID},
  'replyComposer.send':{messageId:UUID,commandId:UUID,text:'Tuesday works.',sourceRevision:'a'.repeat(64),draftRevision:'b'.repeat(64),factRefs:[],envelope:{to:['recipient@example.test'],cc:[]}},
  'social.thumbnail':{assetId:UUID,version:2},
  'social.assets':{},
  'social.removeAsset':{assetId:UUID,commandId:UUID},
  'social.connectAccount':{accountId:UUID,commandId:UUID},
  'social.disconnectAccount':{accountId:UUID,commandId:UUID},
  'social.checkPreparation':{accountId:UUID},
  'social.workspace':{},
  'social.drafts':{},
  'social.weekly':{},
  'social.saveWeekly':{enabled:true,expectedRevision:0,commandId:UUID},
  'social.requestDrafts':{sourceRefs:[{kind:'public',id:UUID,revision:1}],factBlocks:[],commandId:UUID},
  'social.mutate':{action:'approve',postId:UUID,expectedRevision:1,commandId:UUID},
  'outreach.control':{},
  'outreach.preview':{mailboxId:UUID,candidateIds:[UUID],emailSequenceVersionId:null,callSequenceVersionId:null},
  'outreach.mutate':{action:'authorization',mailboxId:UUID,expectedRevision:0,enabled:true,basis:'owner_reported_google_permission',commandId:UUID},
  'sourcing.callNeed':{sessionId:UUID},
  'sourcing.saveCallNeed':{callLogId:UUID,expectedRevision:0,expectedSourceRevision:0,answer:'yes',commandId:UUID},
  'sourcing.learning':{from:'2026-10-01T00:00:00Z',to:'2026-10-06T00:00:00Z',asOf:'2026-10-06T00:00:00Z'},
  'sourcing.targeting':{},
  'sourcing.proposeTargeting':{basePolicyVersion:'targeting-v1',queryChanges:[],rankOrder:['help_request','operational_burden','investigation','fit_only'],evidenceIds:[],rationale:'Review fixture',commandId:UUID},
  'sourcing.applyTargeting':{id:UUID,expectedRevision:1,commandId:UUID},
  'meetings.qualification':{meetingId:UUID},
  'meetings.saveQualification':{meetingId:UUID,expectedRevision:0,buyingParticipant:'unknown',maintenanceNeed:'unknown',openToPaying:'unknown',evidence:[],commandId:UUID},
  'sourcing.feedback':{candidateId:UUID,qualificationRunId:UUID,code:'real_pain',commandId:UUID},
  'sourcing.firmQualification':{firmId:UUID},
  'sourcing.qualification':{candidateId:UUID},
  'sourcing.qualify':{candidateId:UUID,expectedRevision:1,commandId:UUID},
  'sourcing.admit':{candidateId:UUID,expectedRevision:1,qualificationRunId:UUID,mode:'reviewed',commandId:UUID},
  'sourcing.list': {status:'needs_review',offset:0},
  'sourcing.save': {firmName:'Example PM',website:'https://example.test',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Example duties',sourceUrl:'https://example.test/team',observedOn:'2026-10-01',preparedBy:'Fixture',commandId:UUID},
  'sourcing.review': {id:UUID,expectedRevision:1,status:'kept',commandId:UUID},
  'sourcing.check': {id:UUID,expectedRevision:1,commandId:UUID},
  'sourcing.delete': {id:UUID,expectedRevision:1,commandId:UUID},
  'meetings.transcript': { meetingId: UUID },
  'recordings.reupload': { recordingId: UUID },
  'today.openActionV2': { actionId: `reply-message:${UUID}`, target: { kind: 'reply', firmId: UUID, messageId: UUID } },
  'today.openAction': { actionId: `reply-message:${UUID}`, target: { kind: 'reply', firmId: UUID, messageId: UUID } },
  'today.expand': { firmId: UUID },
  'today.snooze': { itemId: UUID, reason: 'later', returnAt: '2026-09-28T09:00' },
  'today.recordOutcome': { itemId: UUID, outcome: 'no_answer', note: '', callback: null },
  'today.previewFollowUp': { firmId: UUID, contactId: UUID, sequenceVersionId: UUID },
  'today.recordAgreedDates': { firmId: UUID, callLogId: STALE_CALL_LOG_ID },
  'today.scheduleCallback': { callLogId: UUID, localDate: '2026-09-28', localTime: '09:00' },
  'today.releasePause': { holdId: UUID },
  'calling.status': { firmId: UUID },
  'calling.start': { firmId: FIXTURE_IDS.firm, contactId: null, routeId: FIXTURE_IDS.route, requestId: UUID },
  'calling.cancel': { requestId: UUID },
  'calling.setActive': { active: true },
  'calling.resume': { firmId: UUID },
  'calling.history': { firmId: UUID },
  'calling.recording': { sessionId: UUID },
  'calling.transcript': { callSessionId: UUID },
  'replies.open': { messageId: UUID },
  'replies.confirm': { messageId: FIXTURE_IDS.message, classification: 'human_reply', callback: null },
  'replies.resolve': { messageId: FIXTURE_IDS.message, opportunityId: FIXTURE_IDS.opportunity },
  'replies.saveModel': { modelName: 'claude-haiku-4-5-20251001' },
  'calling.analysis': { callSessionId: UUID },
  'calling.analysisRetry': { callSessionId: UUID, reason: 'retry' },
  'calling.analysisEdit': { callSessionId: UUID, notes: { summary: 'Ask for Glen.', facts: [] } },
  'calling.proposalsApply': { analysisId: UUID, transcriptSha256: 'a'.repeat(64), proposalHash: 'b'.repeat(64), keys: ['outcome'] },
  'calling.proposalsDecline': { analysisId: UUID, proposalHash: 'b'.repeat(64), keys: ['outcome'] },
  'calling.pendingDismiss': { callSessionId: UUID },
  'review.stageResolve': { itemId: UUID },
  'suppressions.firmStop': { firmId: UUID },
  'suppressions.supersede': { eventId: 'stop-event-1', commandId: UUID },
  'calling.logs': { firmId: UUID },
  'calling.correctionPreview': { callLogId: UUID, outcome: 'interested' },
  'calling.correctOutcome': { commandId: UUID, callLogId: UUID, expectedOutcome: 'no_answer', outcome: 'interested', effects: [] },
  'today.completeTask': { taskId: UUID },
  'research.open': { firmId: UUID },
  'research.run': { firmId: UUID },
  'research.addLink': { firmId: UUID, url: 'https://news.example.test/piece' },
  'research.saveSettings': { dailyFirmCeiling: 25 },
  'crm.relationshipFirms': {},
  'crm.relationshipRead': {personId:UUID,limit:50},
  'crm.relationshipSave': {personId:UUID,firmId:UUID,status:'unknown',startDate:null,endDate:null,evidence:{sourceId:UUID,sourceRevision:1,contentHash:'a'.repeat(64)}},
  'crm.relationshipCorrect': {personId:UUID,firmId:UUID,relationshipId:UUID,expectedRevision:1,status:'unknown',startDate:null,endDate:null,evidence:{sourceId:UUID,sourceRevision:1,contentHash:'a'.repeat(64)}},
  'crm.endpointList': {limit:50},
  'crm.endpointMatch': {kind:'email',value:'info@example.test'},
  'crm.endpointClaim': {kind:'email',value:'info@example.test',personId:null,firmId:UUID,shared:true,status:'unknown',startDate:null,endDate:null,evidence:{sourceId:UUID,sourceRevision:1,contentHash:'a'.repeat(64)}},
  'crm.endpointCorrect': {kind:'email',value:'info@example.test',personId:null,firmId:UUID,shared:true,claimId:UUID,expectedRevision:1,status:'unknown',startDate:null,endDate:null,evidence:{sourceId:UUID,sourceRevision:1,contentHash:'a'.repeat(64)}},
  'crm.firmSourceRead': {firmId:UUID,limit:50},
  'crm.firmSourceAdd': {firmId:UUID,sourceKey:'office-note',excerpt:'Shared office inbox.',occurredAt:'2026-10-08T15:00:00.000Z'},
  'crm.firmSourceDelete': {firmId:UUID,sourceId:UUID,expectedRevision:1},
  'crm.firmSourceRestore': {firmId:UUID,sourceId:UUID,expectedRevision:2},
  'crm.firmSourceRecapture': {firmId:UUID,sourceId:UUID,expectedRevision:3,excerpt:'Shared office inbox.',occurredAt:'2026-10-08T15:00:00.000Z'},
  'crm.sourceContextRead': {personId:UUID,limit:50},
  'crm.sourceContextSave': {personId:UUID,relationshipId:UUID,relationshipRevision:1,evidence:{sourceId:UUID,sourceRevision:1,contentHash:'a'.repeat(64)}},
  'crm.selectedAttachmentCommit': {file:{fileName:'original.txt',declaredByteLength:13,bytesBase64:'U2VsZWN0ZWQgdGV4dA==',completeness:'complete'},personId:null,firmId:UUID,participants:[],occurredAt:null,importKey:'original',previewHash:'a'.repeat(64)},
  'crm.selectedAttachmentAnalyze': {source:{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null},fileHash:'b'.repeat(64)},
  'crm.selectedAttachmentReselect': {file:{fileName:'original.txt',declaredByteLength:13,bytesBase64:'U2VsZWN0ZWQgdGV4dA==',completeness:'complete'},sourceId:UUID,expectedSourceRevision:1,expectedMetadataRevision:1,participants:[],occurredAt:null,previewHash:'a'.repeat(64)},
  'crm.selectedAttachmentRead': {sourceId:UUID},
  'crm.selectedAttachmentPreview': {fileName:'lease.pdf',declaredByteLength:8,bytesBase64:'JVBERi0xLjc=',completeness:'complete'},
  'crm.selectedImportPreview': {text:'Selected passage',subtype:'pasted_text',label:'Selected note',direction:'draft',participants:[],occurredAt:null,attachments:[]},
  'crm.selectedImportRead': {personId:UUID,firmId:null,limit:50},
  'crm.selectedImportCommit': {...{text:'Selected passage',subtype:'pasted_text',label:'Selected note',direction:'draft',participants:[],occurredAt:null,attachments:[]},personId:UUID,firmId:null,importKey:'selected-import',previewHash:'a'.repeat(64),parserVersion:'selected-v1'},
  'crm.selectedImportCorrect': {...{text:'Selected passage',subtype:'pasted_text',label:'Selected note',direction:'draft',participants:[],occurredAt:null,attachments:[]},sourceId:UUID,expectedSourceRevision:1,expectedMetadataRevision:1,previewHash:'a'.repeat(64),parserVersion:'selected-v1'},
  'crm.selectedImportDelete': {sourceId:UUID,expectedSourceRevision:1,expectedMetadataRevision:1},
  'crm.selectedImportRestore': {sourceId:UUID,expectedSourceRevision:1,expectedMetadataRevision:1},
  'crm.selectedImportRecapture': {...{text:'Selected passage',subtype:'pasted_text',label:'Selected note',direction:'draft',participants:[],occurredAt:null,attachments:[]},sourceId:UUID,expectedSourceRevision:1,expectedMetadataRevision:1,previewHash:'a'.repeat(64),parserVersion:'selected-v1'},
  'crm.businessPolicyRead':{},
  'crm.businessPolicySave':{mailboxId:UUID,expectedGeneration:1,expectedAccountBinding:'a'.repeat(64),expectedRevision:0,enabled:false,disclosure:null},
  'crm.businessReviewRead':{mailboxId:UUID,limit:50},
  'crm.businessReviewDecide':{mailboxId:UUID,conversationId:UUID,expectedGeneration:1,expectedAccountBinding:'a'.repeat(64),expectedPolicyRevision:1,expectedMetadataRevision:1,expectedDecisionRevision:0,decision:'exclude'},
  'crm.progressRead':{firmId:UUID,limit:50},
  'crm.evidenceWorkBind':{source:{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null},claimId:UUID,claimRevision:1,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),expectedDecisionRevision:0,work:{kind:'meeting_task',id:UUID,expectedVersion:'1'}},
  'crm.evidenceWorkRead':{work:{kind:'call_task',id:UUID},limit:50},
  'crm.evidenceWorkList':{kind:'selected_note',sourceId:UUID,limit:50},
  'crm.evidenceConflictSave':{expectedConflictRevision:0,members:[UUID,'22222222-2222-4222-8222-222222222222'].map(claimId=>({source:{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null},claimId,claimRevision:1,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),expectedDecisionRevision:0}))},
  'crm.evidenceConflictResolve':{conflictId:UUID,expectedConflictRevision:1,resolution:'keep_both'},
  'crm.evidenceConflictRead':{conflictId:UUID,limit:50},
  'crm.evidenceConflictList':{kind:'selected_note',sourceId:UUID,limit:50},
  'crm.evidenceHistoryRead':{kind:'selected_note',sourceId:UUID,anchorId:UUID,limit:50},
  'crm.evidenceHistoryList':{kind:'selected_note',sourceId:UUID,limit:50},
  'crm.commitmentsReview':{source:{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null},claimId:UUID,claimRevision:1,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),expectedDecisionRevision:0,expectedCommitmentRevision:0,classification:'internal_promise',actor:'self',actionLabel:'Prepare summary',due:{kind:'date',date:'2026-10-12',zone:'UTC',expression:'by October 12'}},
  'crm.commitmentsReviewStatus':{source:{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null},claimId:UUID,claimRevision:1,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),expectedDecisionRevision:0},
  'crm.commitmentsRead':{scope:{kind:'person',personId:UUID},limit:50},
  'crm.commitmentsHistory':{limit:50},
  'crm.commitmentsComplete':{taskId:UUID,expectedVersion:1},
  'crm.evidenceDecide':{source:{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null},claimId:UUID,claimRevision:1,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),expectedDecisionRevision:0,action:'confirm'},
  'crm.evidenceRead':{source:{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null},limit:50},
  'crm.processingSource':{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null},
  'crm.processingRead':{source:{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null}},
  'crm.processingRequest':{source:{workspaceId:UUID,sourceId:UUID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null}},
  'crm.processingPurpose':{},
  'crm.processingHealth':{sourceId:UUID,kind:'selected_note'},
  'crm.processingRecordHealth':{recordId:UUID,kind:'meeting'},
  'crm.processingPurposeSave':{expectedRevision:0,enabled:false,endpointId:'fixture',modelVersion:'fixture-v1',accessGrantVersion:'grant-v1',dataHandlingVersion:'handling-v1',dailyCeilingCents:10,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1},
  'crm.personList': {limit:50},
  'crm.personRead': {personId:UUID,limit:50},
  'crm.personCreate': {fullName:'Alex Example'},
  'crm.personSourceAdd': {personId:UUID,sourceKey:'note-one',excerpt:'Selected evidence.',occurredAt:'2026-10-08T15:00:00.000Z'},
  'crm.personSourceDelete': {personId:UUID,sourceId:UUID,expectedRevision:1},
  'crm.personSourceRestore': {personId:UUID,sourceId:UUID,expectedRevision:2},
  'crm.personSourceRecapture': {personId:UUID,sourceId:UUID,expectedRevision:3,excerpt:'Recaptured evidence.',occurredAt:'2026-10-08T15:00:00.000Z'},
  'crm.dealCreate':{firmId:UUID,name:'Independent pilot'},
  'crm.dealReopen':{firmId:UUID,opportunityId:UUID,reason:'New agreed scope'},
  'crm.openFirm': { firmId: UUID },
  'crm.firmTimeline': { firmId: UUID, before: '2026-09-20T15:00:00.123456|call|abc' },
  'crm.saveContact': { contactId: UUID, fullName: 'Kim Placeholder', title: null, makePrimary: false },
  'crm.changeStage': { opportunityId: UUID, toStageKey: 'new', reason: null },
  'crm.setValue': { opportunityId: UUID, monthlyCents: 120_000, kind: 'estimated' },
  'crm.takeOver': { reason: 'I am writing to them myself.' },
  'crm.resolveOutgoing': { messageId: FIXTURE_IDS.message, opportunityId: FIXTURE_IDS.opportunity },
  'crm.resolveMerge': { sourceFirmId: UUID, targetFirmId: UUID, resolutions: [] },
  'crm.addFirm': {
    name: 'Aspen Test Wealth',
    website: '',
    timeZone: 'America/New_York',
    contactName: '',
    contactTitle: '',
    contactEmail: '',
    contactPhone: '',
  },
  'crm.enroll': { sequenceVersionId: UUID, contactId: UUID },
  'crm.checkRoute': { routeId: UUID, routeVersion: 1 },
  'sequences.openSequence': { sequenceId: UUID },
  'sequences.createSequence': { name: 'Founder plan' },
  'sequences.saveSteps': { sequenceVersionId: UUID, steps: [] },
  'sequences.saveTemplate': {
    templateVersionId: null,
    name: 'First touch',
    subject: 'A question',
    body: 'Hello,',
    signOff: 'David',
  },
  'sequences.publish': { sequenceVersionId: UUID },
  'sequences.retire': { sequenceVersionId: UUID },
  'mailbox.switch': { switchTo: 'new@example.test' },
  'settings.show': { screen: 'settings' },
  'settings.saveSetting': { settingKey: 'business_time_zone', value: { timeZone: 'America/New_York' }, changeNote: '' },
  'settings.openHistory': { settingKey: 'business_time_zone' },
  'settings.loadDashboard': { from: '2026-09-01T00:00:00.000Z', to: '2026-09-28T00:00:00.000Z' },
  'settings.retireStage': { stageKey: 'new' },
  'settings.acknowledgeAlert': { alertId: UUID },
  'settings.setSendingCap': { domain: 'example.test', dailyCap: 10, note: '' },
  'settings.recordSendingAuthentication': {
    domain: 'example.test',
    spfPass: true,
    dkimPass: true,
    dmarcPass: true,
    postmasterReviewed: true,
    automatedSendingEnabled: false,
  },
  'settings.recordHolidayCalendar': { version: '2027-federal', dates: [] },
  'settings.addCallingNumber': { e164: '+14015550150', label: '' },
  'settings.retireCallingNumber': { identityId: UUID },
  'settings.allowStates': { states: ['RI'], confirmed: true, note: '' },
  'settings.revokePosture': { postureId: UUID },
  'meetings.forFirm': { firmId: UUID },
  'meetings.recordingSetup': {meetingId:UUID},
  'meetings.retryRecordingSetup': {meetingId:UUID,expectedVersion:1},
  'meetings.followThrough': { meetingId: UUID },
  'meetings.editRecap': { planId: UUID,expectedPlanVersion:1,expectedDraftVersion:1,action:'begin_edit',commandId:UUID },
  'meetings.outcomes': { meetingId: UUID },
  'meetings.saveNotes': { meetingId: UUID, expectedRevision: 0, debrief: '', speakerMappings: [], itemOverrides: [], sufficient: false, commandId: UUID },
  'meetings.changeTask': { taskId: UUID, expectedVersion: 1, action: 'complete', commandId: UUID },
  'meetings.bookingCapacity': {},
  'meetings.brief': { meetingId: UUID },
  'meetings.match': { meetingId: UUID, firmId: UUID },
  'meetings.setAttendance': { meetingId: UUID, attendance: 'attended', commandId: UUID },
  'firms.saveBasics': { firmId: UUID, regionCode: 'TX' },
  'calls.logIncoming': {
    firmId: UUID,
    contactId: null,
    occurredAt: '2026-10-01T14:00:00.000Z',
    durationSeconds: 120,
    outcome: 'interested',
    note: '',
  },
  'diagnostics.requeueJob': { jobId: UUID, reason: 'the mailbox was reconnected' },
  'recordings.chooseMeeting': { itemId: 'a'.repeat(32), meetingId: UUID },
  'recordings.ignore': { itemId: 'a'.repeat(32) },
  'recordings.retry': { itemId: 'a'.repeat(32) },
  'recordings.forFirm': { firmId: UUID },
  'diagnostics.resolveSend': { outboundMessageId: UUID, resolution: 'delivered' },
});

/**
 * What has to have happened before an operation can reach the server at all.
 *
 * Resolving an ambiguity needs the card it is about to be open; enrolling and opening an
 * opportunity need a firm page; committing an import needs a previewed file. Their
 * traffic is not recorded — the recorder is made fresh afterwards — so what is compared
 * is still one operation's own requests.
 */
const PRIME: Readonly<Partial<Record<OperationName, readonly [string, unknown][]>>> = Object.freeze({
  // "Record the agreed dates" exists only after an agreed sequence went stale on the
  // call (review of S3, round 2, P1-B): the recorded call and its fresh preview first.
  'today.recordAgreedDates': [
    [
      'recordOutcome',
      {
        firmId: UUID,
        itemId: null,
        contactId: UUID,
        routeId: null,
        outcome: 'interested',
        note: '',
        callback: null,
        doNotCallCoversAllContact: false,
        followUpPermission: {
          scope: 'agreed_sequence',
          sequenceVersionId: UUID,
          previewBasis: {
            anchorAt: '2026-09-21T13:00:00.000Z',
            timeZone: 'America/New_York',
            calendarVersionId: 'none.1',
            steps: [{ ordinal: 1, sendAt: '2026-09-22T12:00:00.000Z' }],
          },
        },
      },
    ],
  ],
  // The card has to be the one being resolved, and one of its own candidates chosen:
  // the bridge refuses anything else before it asks the server, which is right and
  // would make this check pass by asking nothing.
  'replies.resolve': [['open', { messageId: FIXTURE_IDS.message }]],
  'crm.openOpportunity': [['openFirm', { firmId: UUID }]],
  'crm.enroll': [['openFirm', { firmId: UUID }]],
  // The takeover needs the same open page: the bridge takes the opportunity from it.
  'crm.takeOver': [['openFirm', { firmId: UUID }]],
  'crm.resolveOutgoing': [['openFirm', { firmId: UUID }]],
  // Calling needs the card open: the route and identity come from it.
  'calling.start': [['expand', { firmId: FIXTURE_IDS.firm }]],
  'crm.commitImport': [['previewImport', { fileName: 'firms.csv', csv: 'name\nAspen Test Wealth\n' }]],
  // Lane PB: committing a prepared-brief import needs a previewed file with a matched row.
  'firms.briefImportCommit': [['briefImportChoose', {}]],
});

type Host = Readonly<Record<string, ((input?: unknown) => Promise<unknown>) | undefined>>;

function hostsFor(api: ReturnType<typeof createAuthedClient>): Readonly<Record<string, Host>> {
  const today = createTodayBridge({
      api,
      session,
      // Never reached: nothing in this file presses Call, and `today.dial` is a channel
      // of its own rather than an operation.
      handoff: createDialHandoff({
        driver: {
          inspectVerifiedHandler: async () => await Promise.resolve('verified' as const),
          isVerifiedHandlerCurrent: () => true,
          openTelUri: async () => await Promise.resolve(),
        },
      }),
    });
  return {
    ask:Object.fromEntries(['read','historyList','historyChange','actionRead','actionChange','actionCreate','answerRequest','answerRead','answerSourceRead'].map(method=>[method,async(input:unknown)=>await operationHandlers({api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps)[`ask.${method}` as OperationName](input as never)])),
    today: { ...today, ...(() => {
      const handlers = operationHandlers({ api, recordings: { identity: { current: () => 0 } } } as unknown as OperationHostDeps);
      return { actionsV2: async () => await handlers['today.actionsV2'](undefined as never), openActionV2: async (input: unknown) => await handlers['today.openActionV2'](input as never), actions: async () => await handlers['today.actions'](undefined as never), openAction: async (input: unknown) => await handlers['today.openAction'](input as never) };
    })() } as unknown as Host,
    // Slice C1: the calling operations are the Today bridge's dial path, under their own names.
    calling: {
      ...Object.fromEntries(
        ['analysis', 'analysisRetry', 'analysisEdit', 'proposalsApply', 'proposalsDecline', 'pendingDismiss', 'recap', 'acceptance', 'trial', 'logs', 'correctionPreview', 'correctOutcome'].map(method => [
          method,
          async (input: unknown) => await operationHandlers({ api } as unknown as OperationHostDeps)[`calling.${method}` as OperationName](input as never),
        ]),
      ),
      expand: async input => await today.expand(input as { firmId: string }),
      status: async input => await today.callingStatus(input as { firmId: string }),
      start: async input => await today.startCall(input as Parameters<typeof today.startCall>[0]),
      setActive: async input => await today.setCallActive(input as { active: boolean }),
      cancel: async input => await today.cancelCall(input as { requestId: string }),
      resume: async input => await today.resumeCalling(input as { firmId: string }),
      history: async input => await today.callHistory(input as { firmId: string }),
      recording: async input => await today.callRecording(input as { sessionId: string }),
      transcript: async input => await today.callTranscript(input as { callSessionId: string }),
    },
    replies: createReplyBridge({ api, session }) as unknown as Host,
    notifications:(()=>{const handlers=operationHandlers({api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);return Object.fromEntries(['read','runtime'].map(method=>[method,async(input:unknown)=>await handlers[`notifications.${method}` as OperationName](input as never)])) as Host;})(),
    replyComposer:(()=>{const handlers=operationHandlers({api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);return Object.fromEntries(['context','generate','preview','sendStatus','send'].map(method=>[method,async(input:unknown)=>await handlers[`replyComposer.${method}` as OperationName](input as never)])) as Host;})(),
    social: (()=>{const socialAccounts=createSocialAccountsBridge({api,identity:async()=>({workspaceId:UUID,userId:UUID}),generation:()=>0,open:async()=>({platform:'linkedin',accountKind:'profile',externalAccountId:'https://www.linkedin.com/in/example/',displayName:'Example'}),clear:async()=>{}});const socialHandoff=createSocialManualHandoffBridge({api,generation:()=>0,copy:async()=>{},open:async()=>{},chooseDestination:async()=>null,write:async()=>{}});const handlers=operationHandlers({api,socialAccounts,socialHandoff,socialDelivery:createSocialDeliveryRunner({api,root:'/unused',identity:async()=>({workspaceId:UUID,userId:UUID}),now:()=>0,adapters:{}}),recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);return {...Object.fromEntries(['manualHandoff','confirmHandoff','useHandoff','registerManualDestination','deliveryStatus','checkPreparation','connectAccount','disconnectAccount','weekly','saveWeekly','drafts','requestDrafts','workspace','mutate','assets','removeAsset','thumbnail','imageStage','chooseImage','pasteImage','imageFromUrl','editImage'].map(method=>[method,async(input:unknown)=>await handlers[`social.${method}` as OperationName](input as never)])), ...Object.fromEntries(['uploadImage','discardImage'].map(action=>[action,async()=>{
      const directory=await mkdtemp(join(tmpdir(),'social-traffic-'));
      try{const image=join(directory,'source.png');await sharp({create:{width:4,height:4,channels:3,background:'red'}}).png().toFile(image);
        const host=createSocialImageImport({directory,api,identity:async()=>({workspaceId:UUID,userId:UUID}),generation:()=>0,chooseFile:async()=>({canceled:false,filePaths:[image]})});
        const chosen=await host.choose({kind:'upload',usageNote:null});if(!chosen.stage)throw new Error('image fixture not prepared');
        if(action==='discardImage')await host.upload({id:chosen.stage.id});
        return await operationHandlers({api,socialImages:host} as unknown as OperationHostDeps)[`social.${action}` as OperationName]({id:chosen.stage.id} as never);
      }finally{await rm(directory,{recursive:true,force:true});}
    }]))} as Host;})(),
    outreach: (()=>{const handlers=operationHandlers({api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);return Object.fromEntries(['control','senderStanding','senderStandingV2','preview','mutate'].map(method=>[method,async(input:unknown)=>await handlers[`outreach.${method}` as OperationName](input as never)])) as Host;})(),
    sourcing: (() => {
      const handlers=operationHandlers({api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);
      return Object.fromEntries(['experiments','saveExperiment','activateExperiment','stopExperiment','eraseExperiment','list','save','review','delete','check','qualification','firmQualification','qualify','admit','feedback','learning','targeting','proposeTargeting','applyTargeting','callNeed','saveCallNeed'].map(method=>[method,async(input:unknown)=>await handlers[`sourcing.${method}` as OperationName](input as never)])) as Host;
    })(),
    research: createResearchBridge({ api, session }) as unknown as Host,
    crm: (()=>{const bridge=createCrmBridge({api,session,clientVersion:'1.0.13'});const handlers=operationHandlers({api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);return {...bridge,...Object.fromEntries(['commitmentsReview','commitmentsReviewStatus','commitmentsRead','commitmentsHistory','commitmentsComplete','evidenceWorkBind','evidenceWorkRead','evidenceWorkList','evidenceConflictSave','evidenceConflictResolve','evidenceConflictRead','evidenceConflictList','evidenceHistoryRead','evidenceHistoryList','evidenceDecide','evidenceRead','progressRead','processingSource','processingRead','processingRequest','processingPurpose','processingPurposeSave','processingHealth','processingRecordHealth','businessMailList','businessMailRead','businessMailReadV2','businessMailImportHealth','businessMailImportRequest','businessMailState','businessMailControls','businessMailDelete','businessMailRestore','businessMailRecapture','businessMailAssociate','dealCreate','dealReopen','businessPolicyRead','businessPolicySave','businessReviewRead','businessReviewDecide','relationshipSave','relationshipCorrect','relationshipFirms','endpointList','endpointMatch','endpointClaim','endpointCorrect','firmSourceRead','firmSourceAdd','firmSourceDelete','firmSourceRestore','firmSourceRecapture','sourceContextRead','sourceContextSave','relationshipRead','selectedAttachmentReselect','selectedAttachmentAnalyze','selectedAttachmentCommit','selectedAttachmentRead','selectedAttachmentPreview','selectedImportPreview','selectedImportRead','selectedImportCommit','selectedImportCorrect','selectedImportDelete','selectedImportRestore','selectedImportRecapture','personList','personRead','personCreate','personSourceAdd','personSourceDelete','personSourceRestore','personSourceRecapture'].map(method=>[method,async(input:unknown)=>await handlers[`crm.${method}` as OperationName](input as never)]))} as unknown as Host;})(),
    sequences: createSequenceBridge({ api, session }) as unknown as Host,
    settings: createAdminBridge({ api, session }) as unknown as Host,
    // Slice M1: answered by `operationHost.ts` against the client directly, like
    // Diagnostics — but walked here, so its declared paths are the ones it asks.
    meetings: (() => {
      const handlers = operationHandlers({ api, recordings: { identity: { current: () => 0 } } } as unknown as OperationHostDeps);
      return {
        forFirm: async input => await handlers['meetings.forFirm'](input as never),
        transcript: async input => await handlers['meetings.transcript'](input as never),
        unmatched: async () => await handlers['meetings.unmatched'](undefined as never),
        match: async input => await handlers['meetings.match'](input as never),
        setAttendance: async input => await handlers['meetings.setAttendance'](input as never),
        recordingSetup: async input => await handlers['meetings.recordingSetup'](input as never),
        retryRecordingSetup: async input => await handlers['meetings.retryRecordingSetup'](input as never),
        followThrough: async input => await handlers['meetings.followThrough'](input as never),
        editRecap: async input => await handlers['meetings.editRecap'](input as never),
        qualification: async input => await handlers['meetings.qualification'](input as never),
        saveQualification: async input => await handlers['meetings.saveQualification'](input as never),
        outcomes: async input => await handlers['meetings.outcomes'](input as never),
        saveNotes: async input => await handlers['meetings.saveNotes'](input as never),
        changeTask: async input => await handlers['meetings.changeTask'](input as never),
        brief: async input => await handlers['meetings.brief'](input as never),
        bookingCapacity: async () => await handlers['meetings.bookingCapacity'](undefined as never),
      };
    })(),
    // Slice S2: answered by `operationHost.ts` against the client directly, like Meetings.
    ...(() => {
      const handlers = operationHandlers({ api } as unknown as OperationHostDeps);
      const through = (names: readonly string[]): Host =>
        Object.fromEntries(
          names.map(name => [name.slice(name.indexOf('.') + 1), async (input: unknown) => await handlers[name as OperationName](input as never)]),
        );
      return {
        // Slice 3a, lane C: the after-call analysis and its siblings, straight through the client.
        review: through(['review.list', 'review.stageResolve']),
        suppressions: through(['suppressions.firmStop', 'suppressions.supersede']),
        firms: (() => {
          // Lane PB: the import is the main process's own host.
          const briefImport = createBriefImport({
            api,
            openDialog: async () => await Promise.resolve({ canceled: false, filePaths: ['/tmp/briefs.json'] }),
            read: async () =>
              await Promise.resolve(
                JSON.stringify([
                  {
                    external_id: 'dfw-20261002-e01',
                    brief: 'Who to ask for: unknown',
                    sources: [{ url: 'https://firm.example.test/', label: 'Source' }],
                    observed_on: '2026-10-02',
                    prepared_by: 'Research agent',
                  },
                ]),
              ),
          });
          const withBriefs = operationHandlers({ api, briefImport } as unknown as OperationHostDeps);
          return {
            saveBasics: async (input: unknown) => await handlers['firms.saveBasics'](input as never),
            briefImportState: async () => await withBriefs['firms.briefImportState'](undefined as never),
            briefImportCommit: async () => await withBriefs['firms.briefImportCommit']({ previewId: (await briefImport.state()).previewId } as never),
            briefImportReset: async () => await withBriefs['firms.briefImportReset'](undefined as never),
            briefImportChoose: async () => await briefImport.choose(),
          } as Host;
        })(),
        calls: { logIncoming: async (input: unknown) => await handlers['calls.logIncoming'](input as never) },
      };
    })(),
    // Lane M4: the import the main process holds. Its four operations make no request of
    // their own (its scan and upload traffic is the importer's, in its own suite); the firm's
    // registered recordings are one read.
    recordings: (() => {
      const importer = createRecordingImporter({
        api,
        fs: { listRoot: async () => await Promise.resolve([]), statFolder: async () => await Promise.resolve(null), listFolder: async () => await Promise.resolve([]), statFile: async () => await Promise.resolve(null), sniff: async () => await Promise.resolve('unreadable' as const), sha256: async () => await Promise.resolve(''), watch: () => null },
        uploader: { put: async () => await Promise.resolve({ ok: true as const }) },
        store: memoryRecordingStore(),
        identity: async () => await Promise.resolve({ workspaceId: UUID, userId: UUID, role: 'admin' as const }),
        defaultFolder: '/tmp/Callie Demos',
        openFolderDialog: async () => await Promise.resolve({ canceled: true, filePaths: [] }),
      });
      // M4 reset, R4: the firm's registered recordings, read through the client directly.
      const handlers = operationHandlers({ api, recordings: importer } as unknown as OperationHostDeps);
      return { ...(importer as unknown as Host), recoveries: async () => await handlers['recordings.recoveries']({} as never), forFirm: async (input: unknown) => await handlers['recordings.forFirm'](input as never) } as unknown as Host;
    })(),
    mailbox: createMailboxBridge({
      api,
      session,
      openExternally: async () => await Promise.resolve(),
    }) as unknown as Host,
  };
}

describe('the registry records the traffic the bridges actually make', () => {
  it('declares every request, method and query string included', async () => {
    const undeclared: string[] = [];
    const asked = new Set<OperationName>();
    for (const name of OPERATION_NAMES) {
      // Diagnostics is answered from `operationHost.ts` against the client directly
      // rather than from a bridge; `operations.test.ts` holds its two paths.
      const [family = '', method = ''] = name.split('.');
      if (family === 'diagnostics') continue;
      const { seen, api } = requestsOf();
      const host = hostsFor(api)[family];
      for (const [primed, input] of PRIME[name] ?? []) await host?.[primed]?.(input);
      seen.length = 0;
      const call = host?.[method];
      if (call === undefined) throw new Error(`no host method for ${name}`);
      await call(INPUTS[name] ?? {});
      if (seen.length > 0) asked.add(name);
      const declared = new Set(OPERATIONS[name].calls.map(entry => `${entry.method} ${entry.path}`));
      for (const request of new Set(seen)) if (!declared.has(request)) undeclared.push(`${name}: ${request}`);
    }
    expect(undeclared).toEqual([]);

    // And every operation that says it reaches the server really did reach it: a
    // fixture that stopped a bridge before its first call would otherwise make this
    // check pass by asking nothing.
    /*
     * `today.refresh` is the one operation whose declared path is not this bridge's to
     * ask for: `POST /today` is the *session manager's* read, made through
     * `session.refreshToday()`, and `desktop.test.ts` holds it. Everything else that
     * declares a call has to have made one here.
     */
    const silent = OPERATION_NAMES.filter(
      name =>
        !name.startsWith('diagnostics.') &&
        name !== 'today.refresh' &&
        OPERATIONS[name].calls.length > 0 &&
        !asked.has(name),
    );
    expect(silent).toEqual([]);
  });

  it('really drives the conditional second calls, so the check above is not vacuous', async () => {
    /*
     * Each of these is a call a bridge makes only when the first answer was good. They
     * are the ones the first review's version of this file could not see, and a fixture
     * that stopped being accepted would make it blind to them again — silently, because
     * "every request was declared" is trivially true of an app that made one request and
     * gave up. So the branches are named, and the traffic has to contain them.
     */
    const branches: readonly [OperationName, string][] = [
      ['today.expand', 'POST /dial/check'],
      ['replies.refresh', 'POST /replies/settings'],
      ['crm.openFirm', 'GET /sequences'],
      ['crm.openFirm', 'POST /sequences/versions'],
      // The merge opens the firm it merged into, which reads the same three (item 10).
      ['crm.resolveMerge', 'POST /sequences/versions'],
      ['settings.show', 'GET /postures'],
      ['social.useHandoff', 'POST /social/manual-handoff/read'],
    ];
    for (const [name, request] of branches) {
      const [family = '', method = ''] = name.split('.');
      const { seen, api } = requestsOf();
      const host = hostsFor(api)[family];
      const call = host?.[method];
      if (call === undefined) throw new Error(`no host method for ${name}`);
      if(name==='social.useHandoff')expect(OPERATIONS[name].input.safeParse(INPUTS[name]??{}).success,`${name} fixture input is invalid`).toBe(true);
      const result=await call(INPUTS[name] ?? {});
      if(name==='social.useHandoff')expect(result).toMatchObject({accepted:true,reason:null});
      expect(seen, `${name} never reached ${request}`).toContain(request);
    }
  });

  it('declares and exercises the negotiated native processing-source reads',async()=>{
    const {seen,api}=requestsOf();const hosts=hostsFor(api);
    await hosts['calling']!['transcript']!({callSessionId:UUID,includeProcessing:true});
    await hosts['meetings']!['transcript']!({meetingId:UUID,includeProcessing:true});
    await hosts['meetings']!['transcript']!({meetingId:UUID,cursor:'page',includeProcessing:true});
    expect(seen).toEqual(['GET /calls/transcript?callSessionId={uuid}&include=processing','GET /meetings/transcript?meetingId={uuid}&include=processing','GET /meetings/transcript?meetingId={uuid}&cursor=page&include=processing']);
    expect(OPERATIONS['calling.transcript'].calls).toContainEqual({method:'GET',path:'/calls/transcript?callSessionId={uuid}&include=processing'});
    expect(OPERATIONS['meetings.transcript'].calls).toContainEqual({method:'GET',path:'/meetings/transcript?meetingId={uuid}&cursor={string}&include=processing'});
  });

  it('names the settings read with the query it actually sends', () => {
    const paths = new Set(OPERATION_NAMES.flatMap(name => OPERATIONS[name].calls.map(entry => entry.path)));
    // Migration 0020's key is only in the snapshot for a caller that asks for it, and
    // this build is that caller: a registry entry of `/settings` would be the request
    // 1.0.12 made, and the deprecated-route check would be reading the wrong list.
    expect([...paths]).toContain('/settings?include=postal_address');
    expect([...paths]).not.toContain('/settings');
  });
});
