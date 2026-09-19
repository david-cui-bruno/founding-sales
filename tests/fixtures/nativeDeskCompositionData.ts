/** Fictional, no-IO equivalent-content acceptance data. Never used in production. */
import { dailySnapshotSchema, type DailySnapshot } from '../../src/shared/contracts/dailyContract';
import { requestedAnswerPresentationSchema, type DisplayContact } from '../../src/shared/contracts/dailyAnswerPresentationContract';
import { commitments, dailyFixture, fixtureNow, nativeDeskFixture, requestedDraft } from '../../src/renderer/features/today/nativeDesk.fixture';
import type { AccountRoute } from '../../src/shared/contracts/accountContract';
import type { LocalCommitmentsSnapshot } from '../../src/shared/contracts/localWorkspaceContract';
import type { ThreadProjection } from '../../src/shared/contracts/mailThreadContract';
import type { AccountPreparation } from '../../src/shared/contracts/accountPreparationContract';
import type { OwnerSourceConfiguration } from '../../src/shared/contracts/ownerCommandContract';

const hash = 'a'.repeat(64);
const names: Record<string, string> = {
  nora: 'Riverton Residential', marcus: 'Cedarline Property Management',
  maya: 'Beacon Residential Management', ben: 'Northfield Property Partners',
  rosa: 'Willowbrook Management', owen: 'Westhaven Residential',
};
export const fictionalCallNote = 'Email me a short outline of what you mean by a one-building pilot. Then we can decide if a conversation makes sense.';
export const fictionalSchedulingQuote = 'Tuesday at 10 am Eastern works for a 30 minute call.';
/** Saved scheduling reply for Beacon Residential Management. The attendee is the sender; nothing here is permission. */
export const fictionalSchedulingThread: ThreadProjection = { revision: 1, contextRevision: 'context-maya',
  signals: [{ kind: 'scheduling', requiresApproval: true, evidence: [{ messageId: 'maya-reply', quote: fictionalSchedulingQuote }] }],
  thread: { accountId: 'maya', mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'thread-maya', messages: [{ id: 'maya-reply', threadId: 'thread-maya', rfcMessageId: null, references: [],
    from: ['maya@beacon.example'], to: ['david@callie.example'], cc: [], date: '2026-09-09T11:30:00.000Z', subject: 'Re: A short conversation',
    bodyParts: [{ mimeType: 'text/plain', text: `${fictionalSchedulingQuote} Send the invite when you can.`, truncated: false }] }] } };
export const fictionalCalendarId = 'founder@callie.example';
export function fictionalMeetingPreparation(): AccountPreparation {
  const configuration: OwnerSourceConfiguration = { version: 1, workspaceId: 'ws', accountId: 'maya', pairingId: 'fixture-pairing', revision: 1, state: 'active', mailboxSubject: 'mailbox', calendarId: fictionalCalendarId, research: null };
  return { workspaceId: 'ws', accountId: 'maya', pairingId: 'fixture-pairing', checkedAt: fixtureNow, authority: { accountId: 'maya', owner: 'worker', generation: 1, state: 'active' }, executionVersion: 1,
    configuration, mailCursor: { mailboxSubject: 'mailbox', envelopeRevision: null, scope: null }, meetingRules: { calendarId: fictionalCalendarId, revision: 1, timezone: 'America/New_York', durationMinutes: 30 } };
}
export const fictionalEmailBody = 'Hi Nora,\n\nYour coordinator should stay central to the discussion. Let’s walk through the current handoff first.\n\nDavid';
const emailRoute: AccountRoute = { id: 'nora-email', accountId: 'nora', personId: 'person-nora', channel: 'email', value: 'nora@riverton.example', purpose: 'business', evidenceIds: ['source-nora'], verification: 'confirmed', version: 1 };
const contact = (route: AccountRoute, displayName: string, role: string, basis: 'recipient_route'): DisplayContact => ({
  basis, personId: route.personId!, personVersion: 1, displayName, route,
  role: { linkId: `${route.accountId}-role`, value: role, validFrom: '2026-09-01T12:00:00.000Z', validTo: null, evidenceIds: [...route.evidenceIds] },
});

export function compositionSnapshot(): DailySnapshot {
  const email = requestedDraft('nora');
  email.sender = 'david@callie.example';
  email.recipient = emailRoute.value;
  email.recipientBinding = { kind: 'account_route', routeId: emailRoute.id, routeVersion: emailRoute.version, email: emailRoute.value };
  email.subject = 'A focused next conversation';
  email.body = fictionalEmailBody;
  const mutable = new Set(['revision', 'subject', 'body', 'evidenceIds', 'generation', 'updatedAt']);
  const requestedPresentation = requestedAnswerPresentationSchema.parse({
    kind: 'requested_followup', asOf: fixtureNow,
    binding: { ...Object.fromEntries(Object.entries(email).filter(([key]) => !mutable.has(key))), workspaceId: 'ws' },
    contact: contact(emailRoute, 'Nora Ellis', 'Operations director', 'recipient_route'),
    callContext: { basis: 'human_reported_call_outcome', originalCall: email.originalCall, outcome: 'connected', observedAt: '2026-09-08T19:10:00.000Z', noteText: fictionalCallNote, linkedContact: null },
    issues: [],
  });
  const accounts: DailySnapshot['accounts'] = Object.entries(names).map(([id, name]): DailySnapshot['accounts'][number] => ({
    account: { id, name, domain: `${id}.example`, version: 1 }, claims: [],
    routes: id === 'nora' ? [emailRoute] : [],
    portfolio: [], unknowns: ['Buying authority not established'], conflicts: [], fingerprint: hash,
  }));
  const meetings: DailySnapshot['meetings'] = ['rosa', 'owen'].map((id, i): DailySnapshot['meetings'][number] => {
    const identity = { meetingId: `meeting-${id}`, calendarId: 'calendar-fixture', providerEventId: i ? 'bbbbb' : 'aaaaa' };
    return { id: identity.meetingId, accountId: id, revision: 1, payload: { commandId: `meeting-command-${id}`, observedAt: fixtureNow,
      outcome: { ...identity, status: 'booked', reason: null, event: { ...identity, status: 'confirmed', etag: 'fixture-etag',
        start: i ? '2026-09-10T14:00:00.000Z' : '2026-09-09T18:30:00.000Z',
        end: i ? '2026-09-10T14:25:00.000Z' : '2026-09-09T18:55:00.000Z',
        attendees: [{ email: `${id}@fixture.invalid`, responseStatus: i ? 'needsAction' : 'accepted' }], meetUrl: null } } } };
  });
  return dailySnapshotSchema.parse(dailyFixture({ accounts, calls: { accountIds: ['maya', 'ben'], workloadConflict: false },
    answers: [{ kind: 'requested_followup', accountId: 'nora', draft: email, approval: null, capability: 'held', reason: 'requires_owner_preflight', presentation: requestedPresentation },
      { kind: 'reply', accountId: 'maya', thread: fictionalSchedulingThread, draft: null, stale: false, capability: 'held', reason: 'reply_capability_unverified' }],
    meetings, campaigns: [], ownerStatus: accounts.map((a): DailySnapshot['ownerStatus'][number] => ({ accountId: a.account.id, authority: { accountId: a.account.id, owner: 'worker', generation: 1, state: 'active' }, executionVersion: 1, pendingCommands: [], status: 'owner_applied' })) }));
}
export function compositionFixture(scenario: 'populated' | 'unpaired' | 'missing' = 'populated') {
  const snapshot = compositionSnapshot();
  if (scenario === 'unpaired') {
    snapshot.workspaceId = null; snapshot.accounts = []; snapshot.answers = []; snapshot.meetings = []; snapshot.ownerStatus = [];
    snapshot.calls = { accountIds: [], workloadConflict: false };
    snapshot.freshness.kind = 'incomplete'; snapshot.issues = [{ code: 'scope_unknown', count: 1 }];
  } else if (scenario === 'missing') {
    for (const answer of snapshot.answers) if (answer.kind !== 'reply') delete answer.presentation;
  }
  const fixture = nativeDeskFixture(dailySnapshotSchema.parse(snapshot));
  if (scenario !== 'unpaired') fixture.setPreparation(fictionalMeetingPreparation());
  if (scenario !== 'unpaired') fixture.setCommitments(commitments({ items: [
    ['jamila', 'Jamila Warren', 'Coastline Residential', '2026-09-09T15:30:00.000Z'],
    ['ellis', 'Ellis Brooks', 'Alder Property Group', '2026-09-09T16:00:00.000Z'],
  ].map(([id, name, company, dueAt]): LocalCommitmentsSnapshot['items'][number] => ({ kind: 'callback', item: {
    id: `cycle-${id}`, lane: 'due_cadence', personId: `person-${id}`, salesCycleId: `cycle-${id}`, personName: name, contextLabel: company,
    stage: 'contacted', priorityContext: null,
    action: { id: `action-${id}`, type: 'follow_up', label: 'Call back', channel: 'call', dueAt },
    reason: 'Return the recorded callback', activeTriggers: [], verifyFirst: false, pinned: false, consentRequirement: null, cloudScores: null,
  } })) }));
  return fixture;
}
