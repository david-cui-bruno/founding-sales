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
  '/calls/log': staleCallBody,
  '/calls/follow-up-preview': followUpPreviewBody,
  '/today/firm': todayFirmBody,
  '/replies': { businessDate: '2026-09-21', cards: [replyCardBody] },
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
  '/replies/card': replyCardBody,
  '/sequences/versions': sequenceVersionsBody,
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
