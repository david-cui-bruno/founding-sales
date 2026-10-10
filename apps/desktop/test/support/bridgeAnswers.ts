import {mailImportHealth} from './mailImportFixture.ts';
/**
 * Bodies every bridge accepts, for the checks that need a bridge to be *holding*
 * something (1.0.13).
 *
 * Two suites read this. `identityReset.test.ts` fills each bridge before it asks it to
 * forget, so that "empty afterwards" is a claim about the reset rather than about a
 * fixture nothing could parse. `registryTraffic.test.ts` drives the bridges with these
 * so that the conditional second calls — the dial advice per usable number, the
 * classifier settings after the lane — actually fire, and the registry is compared with
 * the traffic a working app makes rather than with the traffic a refused one does.
 *
 * No real person, firm or address appears. `example.test` is reserved by RFC 6761.
 */

export const FIXTURE_IDS = Object.freeze({
  firm: '11111111-1111-4111-8111-111111111111',
  item: '22222222-2222-4222-8222-222222222222',
  route: '33333333-3333-4333-8333-333333333333',
  message: '44444444-4444-4444-8444-444444444444',
  opportunity: '55555555-5555-4555-8555-555555555555',
  sequence: '66666666-6666-4666-8666-666666666666',
  otherSequence: '77777777-7777-4777-8777-777777777777',
} as const);

const FIRM_NAME = 'Northwind Test Holdings';

const todayFirmBody = {
  firmId: FIXTURE_IDS.firm,
  firmName: FIRM_NAME,
  snapshotDate: '2026-09-21',
  lane: 'due_work',
  counts: { replies: 0, emailsDue: 1, callsDue: 1 },
  tasks: [
    {
      itemId: FIXTURE_IDS.item,
      contactId: null,
      contactName: 'Dana Example',
      kind: 'call_due',
      lane: 'due_work',
      dueAt: '2026-09-21T13:00:00.000Z',
      status: 'open',
      automated: false,
      snoozeUntil: null,
    },
  ],
  routes: [{ routeId: FIXTURE_IDS.route, contactId: null, e164: '+14015550187', version: 3, eligibility: 'usable' }],
  callingIdentityId: null,
};

const replyCardBody = {
  messageId: FIXTURE_IDS.message,
  receivedAt: '2026-09-21T13:00:00.000Z',
  from: 'reception@northwind.example.test',
  subject: 'Re: introduction',
  body: { text: 'Tuesday works. Send an invite.', truncated: false },
  firmId: FIXTURE_IDS.firm,
  firmName: FIRM_NAME,
  opportunityId: FIXTURE_IDS.opportunity,
  contactId: null,
  contactName: 'Dana Example',
  contactTitle: 'Operations',
  impact: {
    controlMode: 'automated',
    holds: [],
    ambiguous: false,
    candidates: [{ opportunityId: FIXTURE_IDS.opportunity, firmId: FIXTURE_IDS.firm, firmName: FIRM_NAME, selected: true }],
    contactsAtFirm: 3,
  },
  deterministicClass: 'uncertain',
  signals: [],
  proposedDisposition: null,
  proposedBy: 'deterministic',
  confidence: null,
  supportingExcerpt: null,
  callbackProposal: null,
  modelName: null,
  promptVersion: null,
  requiresConfirmation: true,
  confirmation: null,
  nextAction: 'confirm_disposition',
  visibility: 'assigned_or_admin',
};

const firmIdentity = {
  id: FIXTURE_IDS.firm,
  name: FIRM_NAME,
  website: 'https://northwind.example.test',
  locality: null,
  regionCode: null,
  status: 'active',
  assignedUserId: null,
  stageKey: null,
  opportunityStatus: null,
  controlMode: null,
  openedAt: null,
  timeZone: 'America/New_York',
  timeZoneUnresolvedReason: null,
};

const firmPageBody = {
  visibility: 'assigned_or_admin',
  read: {
    visibility: 'assigned_or_admin',
    firm: {
      ...firmIdentity,
      addressLine: null,
      postalCode: null,
      countryCode: 'US',
      timeZoneConfidence: 'high',
      timeZoneSource: 'recorded',
      contacts: [],
      phoneRoutes: [],
      emailRoutes: [],
      aliases: [],
    },
  },
  opportunity: {
    id: FIXTURE_IDS.opportunity,
    status: 'open',
    stageKey: 'new',
    controlMode: 'automated',
    controlModeReason: null,
    controlModeOrigin: null,
    openedAt: '2026-09-25T12:00:00.000Z',
    closedAt: null,
    closeReason: null,
  },
  stageHistory: [],
  holds: [],
  followUpPermissions: [],
};

const settingsBody = {
  settings: [
    {
      settingKey: 'business_time_zone',
      value: { timeZone: 'America/Chicago' },
      version: 2,
      changedAt: '2026-09-19T10:00:00.000Z',
      changedByUserId: '11111111-1111-4111-8111-111111111111',
      changeNote: 'the office moved',
    },
  ],
  elsewhere: [],
  holidayCalendar: { version: 'none.1', dates: [] },
  deploymentSendingEnabled: false,
  effectiveSendingEnabled: false,
};

/**
 * `POST /enrollments` for a firm: an empty list with a time on it.
 *
 * Empty and still valid, which is the point — the *list* is what the Firm page's
 * Sequences section reads next, and an invalid body here stopped the bridge before it
 * reached `/sequences/versions` at all, hiding that call from the registry (item 10).
 */
const enrollmentsBody = { asOf: '2026-09-21T13:00:00.000Z', enrollments: [] };

/** `POST /sequences/versions` for one sequence: one published version. */
const sequenceVersionsBody = {
  versions: [
    {
      id: FIXTURE_IDS.otherSequence,
      sequenceId: FIXTURE_IDS.sequence,
      version: 1,
      state: 'published' as const,
      steps: [],
      publishedAt: '2026-09-20T10:00:00.000Z',
      retiredAt: null,
    },
  ],
};

/** `POST /import/preview`: one row that would create a firm. */
const importPreviewBody = {
  rows: [
    {
      rowNumber: 2,
      outcome: 'create' as const,
      issues: [],
      firm: {
        name: 'Aspen Test Wealth',
        website: null,
        addressLine: null,
        locality: null,
        regionCode: null,
        postalCode: null,
        externalId: null,
        ownerUserId: null,
        timeZone: null,
      },
      contact: null,
      routes: [],
      match: null,
    },
  ],
  counts: { create: 1, attach: 0, duplicate: 0, invalid: 0 },
};

/**
 * An interested call whose agreed sequence was not granted because its dates changed
 * after the preview (review of S3, round 2, P1-B): the card then reads a fresh preview
 * and offers "Record the agreed dates", so both requests are the bridge's to declare.
 */
export const STALE_CALL_LOG_ID = '5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a';
const staleCallBody = {
  status: 'accepted',
  replayed: false,
  result: {
    callLogId: STALE_CALL_LOG_ID,
    outcome: 'interested',
    stepEffect: 'none',
    occurredAt: '2026-09-21T13:05:00.000Z',
    setManual: true,
    suggestedStageKey: null,
    suppressionEventIds: [],
    retiredRouteId: null,
    successorExecutionId: null,
    stepExecutionId: null,
    stepApplication: null,
    callbackId: null,
    completedCallbackId: null,
    followUpPermissionId: null,
    followUps: [{ kind: 'follow_up_not_granted', reason: 'stale_preview' }],
  },
};
const followUpPreviewBody = {
  sequenceVersionId: '11111111-1111-4111-8111-111111111111',
  sequenceName: 'Referrals',
  version: 1,
  firmTimeZone: 'America/New_York',
  holidayCalendarVersion: 'none.1',
  anchoredAt: '2026-09-21T13:06:00.000Z',
  steps: [
    {
      ordinal: 1,
      channel: 'call_task',
      templateVersionId: null,
      templateName: null,
      subject: null,
      templateApproved: null,
      dueAt: '2026-09-22T12:00:00.000Z',
      estimatedAt: '2026-09-22T12:00:00.000Z',
    },
  ],
};

export const BRIDGE_ANSWERS: Readonly<Record<string, unknown>> = Object.freeze({
 '/crm/attachments/commit':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.item,sourceRevision:1,metadataRevision:1}},
 '/crm/attachments/reselect':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.item,sourceRevision:2,metadataRevision:2}},
 '/crm/attachments/analyze':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.item,sourceRevision:1,generationId:FIXTURE_IDS.firm,state:'pending',reason:'adapter_unavailable'}},
 '/crm/attachments/preview':{state:'unsupported',reason:'unsupported_format',processing:'unavailable',supportedFormats:['utf8_text','utf8_markdown','utf8_csv','utf8_srt','utf8_vtt'],maxBytes:80000,maxCharacters:20000},
 '/crm/attachments/read':{file:{state:'selected',sourceRevision:1,metadataRevision:1,fileName:'original.txt',byteLength:13,fileHash:'a'.repeat(64),format:'utf8_text',origin:'user_selected_original'},source:{workspaceId:FIXTURE_IDS.firm,sourceId:FIXTURE_IDS.item,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-09T00:00:00Z',completeness:'selected_excerpt',availability:'available'},processing:{state:'not_requested',claims:[]}},
 '/crm/progress/read':{version:1,events:[],truncated:false,coverage:'partial'},
 '/crm/evidence/conflict/read':{conflictId:FIXTURE_IDS.item,revision:1,state:'open',resolution:null,preferredAnchorId:null,decidedAt:'2026-10-09T00:00:00Z',rationale:null,members:[FIXTURE_IDS.item,FIXTURE_IDS.firm].map(anchorId=>({anchorId,claimId:anchorId,claimRevision:1,claimHash:'a'.repeat(64),kind:'need',interpretation:'Need proposed',status:'inferred',quote:'Original passage',context:{personId:null,firmIds:[],relationships:[],review:'current'},source:{workspaceId:FIXTURE_IDS.firm,sourceId:FIXTURE_IDS.item,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-09T00:00:00Z',completeness:'selected_excerpt',availability:'available'}})),history:[],nextAfterRevision:null},
 '/crm/commitments/review':{status:'accepted',replayed:false,result:{commitmentId:FIXTURE_IDS.item,revision:1,status:'queued'}},
 '/crm/commitments/review/status':{current:null},
 '/crm/commitments/read':{items:[],nextAfterId:null},
 '/crm/commitments/complete':{status:'accepted',replayed:false,result:{taskId:FIXTURE_IDS.item,version:2,completedAt:'2026-10-09T00:00:00.000Z'}},
 '/crm/evidence/decide':{status:'accepted',replayed:false,result:{anchorId:FIXTURE_IDS.item,decisionRevision:1}},
 '/crm/evidence/conflict/save':{status:'accepted',replayed:false,result:{conflictId:FIXTURE_IDS.item,revision:1}},
 '/crm/evidence/conflict/resolve':{status:'accepted',replayed:false,result:{conflictId:FIXTURE_IDS.item,revision:2}},
 '/crm/evidence/conflict/list':{conflicts:[],nextAfterId:null},
 '/crm/evidence/decision/history/list':{anchors:[],nextAfterId:null},
 '/crm/evidence/decision/history/read':{anchorId:FIXTURE_IDS.item,sourceId:FIXTURE_IDS.item,kind:'selected_note',availability:'deleted',originalEventAt:null,originalObservedAt:null,currentDecisionRevision:1,basis:'deleted_redacted',decisions:[],nextBeforeRevision:null},
 '/crm/evidence/work/list':{works:[],nextAfter:null},
 '/crm/evidence/work/read':{work:{kind:'call_task',id:FIXTURE_IDS.item,version:'2026-10-09T00:00:00Z',status:'open',completedAt:null},dependencies:[],nextAfterDependencyId:null},
 '/crm/evidence/work/bind':{status:'accepted',replayed:false,result:{dependencyId:FIXTURE_IDS.item,revision:1}},
 '/crm/evidence/read':{source:{workspaceId:FIXTURE_IDS.firm,sourceId:FIXTURE_IDS.item,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-09T00:00:00Z',completeness:'selected_excerpt',availability:'available'},claims:[],reviewedHistory:[],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page',counts:{current:0,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:0,reviewRequired:0},truncated:false,revisionFingerprint:'b'.repeat(64)}},
 '/crm/processing/source/read':{state:'available',source:{workspaceId:FIXTURE_IDS.firm,sourceId:FIXTURE_IDS.item,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-01T00:00:00Z',completeness:'selected_excerpt',availability:'available'},extent:{unit:'utf16',length:0},passage:null},
 '/crm/processing/read':{state:'not_requested',claims:[]},
 '/crm/processing/request':{status:'accepted',replayed:false,result:{state:'not_requested',claims:[]}},
 '/crm/processing/purpose/read':{configured:false,enabled:false,revision:0,modelVersion:null,endpoint:null,dailyCeilingCents:0,monthlyCeilingCents:0,unavailableReason:'purpose_not_configured'},
 '/crm/processing/purpose/save':{status:'accepted',replayed:false,result:{revision:1,enabled:false}},
 '/crm/processing/record/read':{sources:[],truncated:false},
 '/crm/processing/health/read':{sourceId:FIXTURE_IDS.item,sourceRevision:1,availability:'available',generations:[],truncated:false,unknownAcceptance:false},

'/firms':{firms:[]},
'/crm/relationships/read':{"relationships": [], "nextAfterId": null},
'/crm/relationships/save':{"status": "accepted", "replayed": false, "result": {"relationshipId": "11111111-1111-4111-8111-111111111111", "revision": 1}},
'/crm/relationships/correct':{"status": "accepted", "replayed": false, "result": {"relationshipId": "11111111-1111-4111-8111-111111111111", "revision": 2}},
'/crm/endpoints/list':{"claims": [], "nextAfterId": null},
'/crm/endpoints/match':{"outcome": "no_supported_match", "reason": "no_supported_evidence", "personId": null, "firmId": null, "candidates": []},
'/crm/firm-sources/read':{"sources": [], "nextAfterSourceId": null},
'/crm/relationships/context/read':{"contexts": [], "nextAfterId": null},
'/crm/endpoints/claim':{"status": "accepted", "replayed": false, "result": {"endpointId": "11111111-1111-4111-8111-111111111111", "claimId": "11111111-1111-4111-8111-111111111111", "revision": 1}},
'/crm/endpoints/correct':{"status": "accepted", "replayed": false, "result": {"endpointId": "11111111-1111-4111-8111-111111111111", "claimId": "11111111-1111-4111-8111-111111111111", "revision": 1}},
'/crm/firm-sources/add':{"status": "accepted", "replayed": false, "result": {"sourceId": "11111111-1111-4111-8111-111111111111"}},
'/crm/firm-sources/delete':{"status": "accepted", "replayed": false, "result": {"sourceId": "11111111-1111-4111-8111-111111111111", "revision": 2}},
'/crm/firm-sources/restore':{"status": "accepted", "replayed": false, "result": {"sourceId": "11111111-1111-4111-8111-111111111111", "revision": 2}},
'/crm/firm-sources/recapture':{"status": "accepted", "replayed": false, "result": {"sourceId": "11111111-1111-4111-8111-111111111111", "revision": 2}},
'/crm/relationships/context/save':{"status": "accepted", "replayed": false, "result": {"contextId": "11111111-1111-4111-8111-111111111111", "sourceId": "11111111-1111-4111-8111-111111111111", "relationshipId": "11111111-1111-4111-8111-111111111111", "relationshipRevision": 1}},

  "/crm/capability/read": {
    capability: "crm_extraction",mailboxId: null,configured:false,revision:0,enabled:false,ready:false,reason: "configuration_unavailable",
    authorityReceiptId: null,
    proposedRevision:1,
    proposedConfigurationFingerprint: null,
    configuration: null,
  },
  "/crm/business/policy/activate": {status:'accepted',replayed:false,result: {revision:2,enabled: true,
      authorityReceiptId: FIXTURE_IDS.firm,
    },
  },
  "/crm/business/policy/disable": {status:'accepted',replayed:false,result: {revision:2,enabled:false, authorityReceiptId: null },
  },
  "/crm/business/mail/controls/activate": {status:'accepted',replayed:false,result: {revision:2,enabled: true,
      authorityReceiptId: FIXTURE_IDS.firm,
    },
  },
  "/crm/business/mail/controls/disable": {status:'accepted',replayed:false,result: {revision:2,enabled:false, authorityReceiptId: null },
  },
  "/crm/processing/purpose/activate": {status:'accepted',replayed:false,result: {revision:2,enabled: true,
      authorityReceiptId: FIXTURE_IDS.firm,
    },
  },
  "/crm/processing/purpose/disable": {status:'accepted',replayed:false,result: {revision:2,enabled:false, authorityReceiptId: null },
  },
  "/ask/purpose/activate": {status:'accepted',replayed:false,result: {revision:2,enabled: true,
      authorityReceiptId: FIXTURE_IDS.firm,
    },
  },
  "/ask/purpose/disable": {status:'accepted',replayed:false,result: {revision:2,enabled:false, authorityReceiptId: null }},

 '/crm/business/policy/read':{mailboxId:FIXTURE_IDS.firm,ownerUserId:FIXTURE_IDS.firm,emailAddress:'owner@example.test',generation:1,accountBinding:'a'.repeat(64),revision:0,enabled:false,scopeDays:90,classificationMode:'metadata_only',disclosure:null,ready:false,reasons:['disclosure_required','activation_not_available'],metadataReviewDisclosureText:'Metadata only; no capture or sending authority.',metadataReviewDisclosure:{version:'business-metadata-review-v1',sha256:'b'.repeat(64)}},
 '/crm/business/policy/save':{status:'accepted',replayed:false,result:{revision:1}},
 '/crm/business/review/read':{available:false,reasons:['disclosure_required'],mailboxId:FIXTURE_IDS.firm,accountBinding:'a'.repeat(64),generation:1,policyRevision:0,captureAllowed:false,conversations:[],nextAfter:null},
 '/crm/business/review/decide':{status:'accepted',replayed:false,result:{decisionRevision:1,captureAllowed:false}},
 '/crm/business/mail/list':{sources:[],nextAfterId:null},
 '/crm/business/mail/read/v2':{state:'unavailable',reason:'provenance_unavailable',source:null},
 '/crm/business/mail/import/read':mailImportHealth(),
 '/crm/business/mail/import/request':{status:'accepted',replayed:false,result:{importId:'11111111-1111-4111-8111-111111111111',status:'queued'}},
 '/crm/business/mail/read':{state:'unavailable',reason:'provenance_unavailable',source:null},
 '/crm/business/mail/state/read':{revision:1,availability:'available'},
 '/crm/business/mail/controls/read':{mailboxId:FIXTURE_IDS.firm,enabled:false,ready:false,reason:'activation_not_available',revision:0},
 '/crm/business/mail/delete':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.message,sourceRevision:2,availability:'deleted'}},
 '/crm/business/mail/restore':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.message,sourceRevision:3,availability:'awaiting_recapture'}},
 '/crm/business/mail/recapture':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.message,sourceRevision:3,status:'queued'}},
 '/crm/business/mail/associate':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.message,sourceRevision:2}},
 '/crm/people/list':{people:[],nextAfterId:null},
 '/crm/imports/preview':{previewHash:'a'.repeat(64),parserVersion:'selected-v1',participants:[],occurredAt:null,dateProvenance:'unknown',direction:'draft',directionVerified:false,attribution:'unknown',candidates:[],warnings:[]},
 '/crm/imports/read':{imports:[],nextAfterId:null},
 '/crm/imports/commit':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.firm,sourceRevision:1,metadataRevision:1}},
 '/crm/imports/correct':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.firm,sourceRevision:1,metadataRevision:1}},
 '/crm/imports/delete':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.firm,sourceRevision:1,metadataRevision:1}},
 '/crm/imports/restore':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.firm,sourceRevision:1,metadataRevision:1}},
 '/crm/imports/recapture':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.firm,sourceRevision:1,metadataRevision:1}},
 '/crm/people/read':{person:{personId:FIXTURE_IDS.firm,fullName:'Alex Example',firm:null,revision:1},sources:[],nextAfterSourceId:null},
 '/crm/people/create':{status:'accepted',replayed:false,result:{personId:FIXTURE_IDS.firm}},
 '/crm/people/source/add':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.firm}},
 '/crm/people/source/delete':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.firm,revision:2}},
 '/crm/people/source/restore':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.firm,revision:3}},
 '/crm/people/source/recapture':{status:'accepted',replayed:false,result:{sourceId:FIXTURE_IDS.firm,revision:4}},
  '/social':{accounts:[{id:'11111111-1111-4111-8111-111111111111',platform:'linkedin',externalId:'https://www.linkedin.com/in/example/',displayName:'Example',accountKind:'profile',state:'unsupported',adapterVersion:null,verifiedAt:null}],posts:[]},
  '/calls/log': staleCallBody,
  '/calls/follow-up-preview': followUpPreviewBody,
  '/today/firm': todayFirmBody,
  '/replies': { businessDate: '2026-09-21', cards: [replyCardBody] },
  '/crm/firm-page-v3':(()=>{const {opportunity,stageHistory,...common}=firmPageBody;return {...common,version:3,opportunities:[{opportunity,stageHistory,stageControlMode:'legacy_rules',displayName:'Test pilot'}]};})(),
  '/opportunities/v2/open':{status:'accepted',replayed:false,result:{opportunityId:FIXTURE_IDS.opportunity}},
  '/opportunities/v2/reopen':{status:'accepted',replayed:false,result:{opportunityId:FIXTURE_IDS.opportunity}},
  '/crm/firm-page': firmPageBody,
  // One held outgoing message, so `crm.resolveOutgoing` reaches the server (S1 review P1-C).
  '/messages/held-outgoing': {
    messages: [
      {
        messageId: FIXTURE_IDS.message,
        internalDate: '2026-09-21T14:00:00.000Z',
        candidates: [{ opportunityId: FIXTURE_IDS.opportunity, firmId: FIXTURE_IDS.firm, firmName: FIRM_NAME }],
      },
    ],
  },
  // The board as the server sends it for somebody else: no opportunity of this firm's,
  // because this caller may not change its stage.
  '/pipeline/board-v2':{version:2,columns:[],cards:{},unplacedFirms:[firmIdentity],stages:[]},
  '/pipeline/board': { columns: [], opportunityIdByFirmId: {}, unplacedFirms: [firmIdentity] },
  '/settings': settingsBody,
  '/sequences': {
    sequences: [
      { id: FIXTURE_IDS.otherSequence, name: 'Founding outreach', description: null, archivedAt: null },
      { id: FIXTURE_IDS.sequence, name: 'Referrals', description: null, archivedAt: null },
    ],
  },
  '/enrollments': enrollmentsBody,
  '/import/preview': importPreviewBody,
  // Lane PB: one prepared-brief row matched, so committing the import reaches the set command.
  '/firms/brief/match': {
    rows: [{ status: 'matched', firmId: '11111111-1111-4111-8111-111111111111', firmName: 'Aspen Test Wealth', matchedOn: 'external_id' }],
  },
  '/replies/card': replyCardBody,
  '/sequences/versions': sequenceVersionsBody,
  '/ask/actions/read':{items:[],nextAfterId:null},
  '/ask/actions/change':{status:'accepted',replayed:false,result:{actionId:'11111111-1111-4111-8111-111111111111',version:2,status:'done',completedAt:'2026-10-09T12:00:00Z'}},
  '/ask/actions/create':{status:'accepted',replayed:false,result:{actionId:'11111111-1111-4111-8111-111111111111',version:1,kind:'preference'}},
  '/ask/history/change':{status:'accepted',replayed:false,result:{requestId:'11111111-1111-4111-8111-111111111111',historyRevision:2,requestVersion:1,state:'complete'}},
  '/ask/history/list':{items:[],nextCursor:null},
  '/ask/answers/request':{status:'accepted',replayed:false,result:{requestId:'11111111-1111-4111-8111-111111111111',version:1,state:'unavailable'}},
  '/ask/answers/read':{requestId:'11111111-1111-4111-8111-111111111111',version:1,createdAt:'2026-10-09T11:00:00Z',state:'unavailable',reason:'evaluation_unavailable',question:'Why?',fallback:null,answer:null},
  '/ask/answers/source/read':{requestId:'11111111-1111-4111-8111-111111111111',version:1,windowId:'11111111-1111-4111-8111-111111111111',source:{state:'available',source:{workspaceId:'11111111-1111-4111-8111-111111111111',sourceId:'11111111-1111-4111-8111-111111111111',kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:'text:0:3',speaker:null,occurredAt:null,observedAt:'2026-10-09T11:00:00Z',completeness:'selected_excerpt',availability:'available'},extent:{unit:'utf16',length:3},passage:{text:'Why',locator:'text:0:3',speaker:null}}},
  '/ask/read':{operation:'records',selection:'none',records:[],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}},
  '/gmail/status': {
    connected: true,
    mailbox: {
      id: FIXTURE_IDS.message,
      emailAddress: 'sales@example.test',
      status: 'connected',
      syncState: 'ready',
      coverageWatermarkAt: null,
      lastSyncedAt: '2026-09-21T13:00:00.000Z',
      lastSyncError: null,
    },
  },
});
