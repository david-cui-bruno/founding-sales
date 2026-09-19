import { classifyResearchPhaseHold, runResearch } from './researchCoordinator';
import type { ResearchSetupProfile } from './researchSetup';
import { QueryCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { ownerCommandSchema, ownerSourceConfigurationSchema, ownerSourceKey, type OwnerSourceConfiguration } from '../../../../src/shared/contracts/ownerCommandContract';
import { commandReceiptSchema, workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
import { pairingKey, type WorkerAuth } from './workerAuth';
import type { RemoteGoogleAuthorization } from './remoteGoogleAuthorization';
import { fingerprint, integer, keyPart, type Stored, type DynamoAdapter } from './dynamoStore';
import { DynamoThreadIntakeRepository, mailCursorKey } from './threadIntakeRepository';
import { createMailPoller } from './mailPoller';
import { DynamoDispatchRepository } from './dispatchRepository';
import { createExecutionRepository, authorityRecordSchema, executionAuthorityKey, executionAuthorityFields } from './executionRepository';
import { CampaignExecution } from './campaignExecution';
import { WorkerCampaignRepository } from './workerCampaignRepository';
import { createDispatchService } from './dispatchService';
import { createSendReconciler } from './sendReconciler';
import type { PageHttp } from '../../../../src/main/research/companyPageProvider';
import { DynamoMeetingRepository, meetingOfferKey } from './meetingRepository';
import { meetingOfferSchema } from '../../../../src/shared/contracts/meetingContract';
import { MeetingCoordinator } from './meetingCoordinator';
import { loadRequestedApproval, requestedApprovalKey, requestedApprovalRecordSchema, type RequestedApprovalRecord } from './requestedFollowupApproval';
import { DynamoRequestedFollowupRepository, requestedFollowupDraftKey, type RequestedContextPlan } from './requestedFollowupRepository';
import { requestedFollowupDraftSchema, type RequestedApprovalStatus } from '../../../../src/shared/contracts/requestedFollowupContract';
import { requestedFollowupContextRevision, validateRequestedDraftContext } from '../../../../src/main/outreach/requestedFollowupService';
import { mailAccountScopeSchema } from '../../../../src/shared/contracts/mailThreadContract';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import type { TickHeldReason, TickPhase, TickPhaseHold, TickPhaseResult } from '../../../../src/shared/contracts/researchSetupContract';
import { buildScheduledRunRecord, tickErrorClass, SOURCE_LAST_TICK_KEY } from './tickLog';
import { recordAttempt, type AttemptInput } from './v1/attempts';
import { TerritoryPolicyRepository, TERRITORY_BACKFILL_TICK_LIMIT, type TerritoryBackfillReport } from './territoryPolicyRepository';
import { createSequenceEmailWalker, type SequenceEmailReport } from './sequenceEmailWalker';
import { createTerritoryMailScopeConfigurator, type TerritoryMailScopeReport } from './territoryMailScope';

export type SourceResearchBoundaries = { loadCredentials(workspaceId: string, signal: AbortSignal): Promise<{ apiKey: string; model: string }>;
  /** Present only when the Places credential parameter is declared; a Places configuration is held without it. */
  loadPlacesCredentials?(workspaceId: string, signal: AbortSignal): Promise<{ apiKey: string }>;
  pageHttp: PageHttp; resolve(hostname: string): Promise<string[]> };
export type SourceCoordinatorOptions = { auth: WorkerAuth; authorization: RemoteGoogleAuthorization; fetch: typeof globalThis.fetch; research?: SourceResearchBoundaries; researchSetupProfile?: ResearchSetupProfile };
/** What one Places territory batch did. `uncertain` names a page whose response was lost: its spend is retained and it is never re-issued. */
export type PlacesBatchReport = { outcome: 'completed' | 'exhausted' | 'uncertain' | 'denied' | 'held'; runId: string | null; created: number; routes: number; enqueued: number; drained: number;
  skipped: { no_website: number; website_blocked: number; duplicate_domain: number; duplicate_phone: number; existing_domain: number; existing_phone: number; route_held: number; enqueue_held: number } };
export type SourceTickReport = { status: 'inactive' | 'completed' | 'aborted'; researchPrepared: number; researchCompleted: number;
  mailPolls: number; dispatches: number; sendReconciliations: number; meetings: number; held: number;
  /** Present only when the research phase ran a Places territory batch. */
  places?: PlacesBatchReport;
  /** Present only when the territory backfill phase ran. */
  territory?: TerritoryBackfillReport;
  /** Present only when the sequence email walk ran, in the same phase and over the firms that sweep scanned. */
  sequenceEmails?: SequenceEmailReport;
  /** Present only when the per-firm mail scope step ran, in the same phase and over the same firms, before the walk. */
  mailScopes?: TerritoryMailScopeReport;
  /** Every hold is also counted under one closed reason; the sum equals `held`. */
  heldByReason: Partial<Record<TickHeldReason, number>>;
  /** How each phase ended this tick; a phase the deadline never reached is `skipped`. */
  phases: Partial<Record<TickPhase, TickPhaseResult>>;
  /** The named condition a phase that did not do its work hit, instead of an anonymous failure. Closed reasons and constructor classes only. */
  phaseHolds: Partial<Record<TickPhase, TickPhaseHold>>;
  /** Model extraction on the scheduled Places path: calls made, the cost settled against reservations and what those reservations refunded. */
  extraction: { calls: number; settledCostMicros: number; refundedMicros: number };
  /** Remaining balances of the active policy's two ledgers after the research phase; null when no policy or ledger was read. */
  ledger: { discoveryRemainingMicros: number; researchRemainingMicros: number } | null;
  /** The operator review has lapsed; `selfPaused` is true only on the tick that wrote the pause. */
  descriptorExpired: boolean; selfPaused: boolean };
export const emptyTickReport = (): SourceTickReport => ({ status: 'inactive', researchPrepared: 0, researchCompleted: 0, mailPolls: 0, dispatches: 0,
  sendReconciliations: 0, meetings: 0, held: 0, heldByReason: {}, phases: {}, phaseHolds: {}, extraction: { calls: 0, settledCostMicros: 0, refundedMicros: 0 }, ledger: null, descriptorExpired: false, selfPaused: false });
/** The only way a tick report gains a hold: the total and its reason move together. */
export function hold(report: SourceTickReport, reason: TickHeldReason): void {
  report.held++;
  report.heldByReason[reason] = (report.heldByReason[reason] ?? 0) + 1;
}
const PAGE_LIMIT = 25;
/** One scheduled tick aborts after this; the 60 s Lambda timeout leaves room for setup and durable settlement. */
export const TICK_DEADLINE_MS = 45000;
/** Research may create a page of companies and drain their page research within its slice; the other four phases share what is left,
 *  so the five slices always fit inside one tick. */
export const PHASE_SLICES_MS = [18000, 7000, 7000, 7000, 6000] as const;
const cursorSchema = z.strictObject({ after: z.string().min(1).max(2048).nullable() });
const submittedSchema = z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), receipt: commandReceiptSchema,
  sequence: integer.positive(), command: ownerCommandSchema });
type SourceRecord = Stored<OwnerSourceConfiguration>;
/** Internal bounded source processing only. No constructor IO, schedule, public
 * tick command, synthetic work queue, permission inference or automatic activation. */
export function createSourceCoordinator(input: SourceCoordinatorOptions) {
  if (input.authorization.input.auth !== input.auth) throw new Error('source_store_mismatch');
  const store = input.auth.store;
  const threads = new DynamoThreadIntakeRepository(store.options);
  const poller = createMailPoller({ authorization: input.authorization, store: threads, fetch: input.fetch });
  const campaigns = new CampaignExecution(new WorkerCampaignRepository(store.options));
  const policy = new DynamoDispatchRepository(store.options, input.authorization, campaigns);
  const execution = createExecutionRepository({ ...store.options, dispatchPolicy: policy });

  async function page(prefix: string) {
    const cursorKey = `SOURCE_SCAN#${fingerprint(prefix)}`;
    const cursor = await store.get<unknown>(cursorKey);
    const after = cursor ? cursorSchema.parse(cursor.data).after : null;
    if (after && !after.startsWith(prefix)) throw new Error('source_cursor_mismatch');
    const result = await store.options.dynamo.send(new QueryCommand({ TableName: store.options.tableName, ConsistentRead: true, Limit: PAGE_LIMIT,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': store.key('').pk, ':prefix': { S: prefix } }, ...(after ? { ExclusiveStartKey: store.key(after) } : {}) }));
    if ((result.Items?.length ?? 0) > PAGE_LIMIT) throw new Error('source_page_unbounded');
    const rows = (result.Items ?? []).map(item => {
      if (item.pk?.S !== store.key('').pk.S || !item.sk?.S?.startsWith(prefix) || after && item.sk.S <= after || typeof item.data?.S !== 'string') throw new Error('source_record_mismatch');
      return { key: item.sk.S, rev: integer.positive().parse(Number(item.rev?.N)), data: JSON.parse(item.data.S) as unknown };
    });
    const next = result.LastEvaluatedKey?.sk?.S ?? null;
    if (next && (!next.startsWith(prefix) || result.LastEvaluatedKey?.pk?.S !== store.key('').pk.S || next !== rows.at(-1)?.key || after && next <= after)) throw new Error('source_cursor_mismatch');
    let revision = cursor?.rev ?? null;
    return { rows, async advance(position: string | null = next) {
      if (rows.length || after || next) {
        await store.transact([store.put(cursorKey, { after: position }, revision)]);
        revision = (revision ?? 0) + 1;
      }
    } };
  }
  async function source(accountId: string): Promise<SourceRecord | null> {
    const row = await store.get<unknown>(ownerSourceKey(accountId));
    if (!row) return null;
    const config = ownerSourceConfigurationSchema.parse(row.data);
    if (config.workspaceId !== store.options.workspaceId || config.accountId !== accountId || config.state !== 'active') return null;
    await input.auth.activePairing(config.pairingId);
    return { ...row, data: config };
  }
  async function unchanged(record: SourceRecord): Promise<OwnerSourceConfiguration> {
    const current = await source(record.data.accountId);
    if (!current || current.rev !== record.rev || fingerprint(current.data) !== fingerprint(record.data)) throw new Error('source_changed');
    return current.data;
  }
  async function publications(signal: AbortSignal) {
    if (!store.options.publish) return;
    const key = 'SOURCE_PUBLICATION_CURSOR';
    const cursor = await store.get<unknown>(key);
    const after = cursor ? z.strictObject({ sequence: integer }).parse(cursor.data).sequence : 0;
    const head = await store.get<unknown>('EVENT_HEAD');
    const high = head ? z.strictObject({ sequence: integer }).parse(head.data).sequence : 0;
    if (after > high) throw new Error('source_publication_cursor_invalid');
    let sequence = after;
    for (; sequence < high && sequence < after + PAGE_LIMIT; sequence++) {
      signal.throwIfAborted();
      // Missing/gapped or unavailable publication throws before cursor advancement.
      await store.publish(sequence + 1);
    }
    if (sequence !== after) await store.transact([store.put(key, { sequence }, cursor?.rev ?? null)]);
  }
  async function research(signal: AbortSignal, report: SourceTickReport) {
    try { return await runResearch(input, signal, report); }
    catch (error) {
      // The phase names the condition it hit before the tick records an anonymous failure. An abort is a deadline, not a condition.
      if (!signal.aborted) report.phaseHolds.research = await classifyResearchPhaseHold(input, error);
      throw error;
    }
  }
  /** Firms that already existed when the territory policy was approved receive authority exactly as a newly admitted firm does.
   * Its own phase, not a step of research: the sweep must keep running while research is paused or its descriptor needs replacing. */
  async function territoryBackfill(signal: AbortSignal, report: SourceTickReport) {
    let result: TerritoryBackfillReport;
    // Which firms this sweep actually reached. The sequence email walk below rides on exactly that list, so it
    // inherits the sweep's own bound and its persisted cursor instead of scanning the account table a second time.
    const swept: string[] = [];
    try { result = await new TerritoryPolicyRepository(store.options).sweepTerritoryBackfill({ limit: TERRITORY_BACKFILL_TICK_LIMIT, signal, onFirm: accountId => swept.push(accountId) }); }
    catch (error) {
      // The sweep answers every expected condition as an outcome, so a throw here is genuinely unexpected: name its class, never its message.
      if (!signal.aborted) report.phaseHolds.territoryBackfill = { reason: 'phase_error', errorClass: tickErrorClass(error) };
      throw error;
    }
    report.territory = result;
    // Only a genuinely failed enrollment is a hold; a missing policy, a paused policy, an owned firm and an unusable route are expected outcomes.
    for (let count = 0; count < result.skipped.enrollment_failed; count++) hold(report, 'territory_backfill_held');
    // The per-firm mail scope (D13, lane 41), before the walk and never after it: a firm configured here is
    // polled by the configurations phase of this tick or the next one, and the walk sends on the tick after
    // that poll. Running it first is what makes the scope one tick old by the time a send is attempted, so a
    // firm is never held with `mailbox_not_connected` for a scope this same tick already created. It issues
    // one `configure-owner` per firm and sends nothing.
    const scopes = await createTerritoryMailScopeConfigurator({ auth: input.auth, authorization: input.authorization,
      options: store.options }).configureDueMailScopes(swept, signal);
    report.mailScopes = scopes;
    for (let count = 0; count < scopes.failed; count++) hold(report, 'territory_backfill_held');
    // The sequence's due email steps (D13, lane 40). Its own refusals are named holds recorded on the step, so only
    // a firm whose walk threw something unexpected becomes a tick hold. Nothing here dials, books or advances a cadence.
    const emails = await createSequenceEmailWalker({ options: store.options, policy, execution, authorization: input.authorization,
      fetch: boundFetch(signal) }).walkDueEmailSteps(swept, signal);
    report.sequenceEmails = emails;
    report.dispatches += emails.sent;
    for (let count = 0; count < emails.held; count++) hold(report, 'dispatch_held');
    for (let count = 0; count < emails.failed; count++) hold(report, 'territory_backfill_held');
  }
  async function meetingCursor(accountId: string, kind: string) {
    const key = `SOURCE_SCAN#${fingerprint({ accountId, kind })}`;
    const row = await store.get<unknown>(key);
    return { after: row ? cursorSchema.parse(row.data).after : null,
      advance: (after: string | null) => store.transact([store.put(key, { after }, row?.rev ?? null)]) };
  }
  async function meetings(active: SourceRecord, signal: AbortSignal, fetch: typeof globalThis.fetch, report: SourceTickReport) {
    const config = await unchanged(active); if (!config.calendarId || !config.mailboxSubject) return;
    const repository = new DynamoMeetingRepository(store.options, input.authorization);
    const coordinator = new MeetingCoordinator({ repository, authorization: input.authorization, calendarId: config.calendarId, fetch });
    const workCursor = await meetingCursor(config.accountId, 'work');
    const work = await repository.listPreparedIntents(config.accountId, workCursor.after, PAGE_LIMIT);
    const processed = new Set<string>();
    for (const item of work.work) { signal.throwIfAborted(); await unchanged(active);
      if (item.input.calendarId !== config.calendarId || item.input.intent.pairingId !== config.pairingId || item.input.intent.mailboxSubject !== config.mailboxSubject) continue;
      const result = await coordinator.coordinateMeeting(item.input.intent, signal); processed.add(item.input.intent.commandId); report.meetings++;
      if (result.status === 'held' || result.status === 'unknown') hold(report, 'meeting_held');
    }
    await workCursor.advance(work.nextCursor);
    const offersCursor = await meetingCursor(config.accountId, 'offers');
    const offers = await repository.listAcceptedOffers(config.accountId, offersCursor.after, PAGE_LIMIT);
    // Reserve/settle one current agreement before freezing the next account version.
    // Existing reserved/unknown work is never re-prepared or resent.
    for (const offer of offers.offers) { signal.throwIfAborted(); await unchanged(active);
      const item = await repository.prepareOfferedReply({ accountId: config.accountId, threadId: offer.threadId });
      if (!item || processed.has(item.input.intent.commandId)) continue;
      if (item.input.calendarId !== config.calendarId || item.input.intent.pairingId !== config.pairingId || item.input.intent.mailboxSubject !== config.mailboxSubject) continue;
      const result = await coordinator.coordinateMeeting(item.input.intent, signal); processed.add(item.input.intent.commandId); report.meetings++;
      if (result.status === 'held' || result.status === 'unknown') hold(report, 'meeting_held');
    }
    await offersCursor.advance(offers.nextCursor);
    const reservationCursor = await meetingCursor(config.accountId, 'reservations');
    const reservations = await repository.listReservations(config.accountId, reservationCursor.after, PAGE_LIMIT);
    for (const record of reservations.records) { signal.throwIfAborted();
      if (processed.has(record.intent.commandId) || record.outcome && record.outcome.status !== 'unknown') continue;
      await unchanged(active);
      if (record.identity.calendarId !== config.calendarId || record.intent.pairingId !== config.pairingId || record.intent.mailboxSubject !== config.mailboxSubject) continue;
      await coordinator.coordinateMeeting(record.intent, signal); report.meetings++;
    }
    // Empty filtered pages still carry a continuation and must advance.
    await reservationCursor.advance(reservations.nextCursor);
  }
  type CapturedRequested = NonNullable<Awaited<ReturnType<typeof loadRequestedApproval>>>;
  const checkKey = (item: TransactWriteItem) => item.ConditionCheck?.Key?.sk?.S;
  async function requestedStatus(captured: CapturedRequested, state: RequestedApprovalRecord['state'], reason: string, evidence: TransactWriteItem[] = []) {
    if (captured.record.state !== 'pending_preflight' || captured.record.state === state && captured.record.lastReason === reason) return;
    const key = executionAuthorityKey(captured.record.accountId); const row = await store.get<unknown>(key); if (!row) throw new Error('authority_missing');
    const authority = authorityRecordSchema.parse(row.data);
    if (authority.authority.accountId !== captured.record.accountId) throw new Error('authority_identity_conflict');
    const next = { ...authority, version: authority.version + 1 };
    const record = requestedApprovalRecordSchema.parse({ ...captured.record, state, lastReason: reason, materializedIntentId: null });
    const status: RequestedApprovalStatus = { receipt: captured.receipt, state, intentCommandId: null, reason };
    const outbox = await store.eventItems(workerEventSchema.parse({ id: `requested-status-${fingerprint([record.commandId,state,reason,next.version])}`,
      workspaceId: store.options.workspaceId, accountId: record.accountId, authorityGeneration: next.authority.generation, aggregateVersion: next.version,
      kind: 'requested_followup.status', payload: { commandId: record.commandId, draftId: record.draftSnapshot.id, status } }));
    await store.transact([...captured.checks.filter(item => checkKey(item) !== requestedApprovalKey(record.commandId)),...evidence,
      store.put(requestedApprovalKey(record.commandId),record,captured.revision), store.put(key,next,row.rev,executionAuthorityFields(next),executionAuthorityFields(authority)), ...outbox.items]);
  }
  async function requestedPairingRevocation(captured: CapturedRequested): Promise<TransactWriteItem[]> {
    const key = pairingKey(captured.record.pairingId); const row = await store.get<unknown>(key);
    // A generic authorization error is not revocation evidence. Only the durable
    // exact pairing tombstone produced by revokePairing, with advanced generation,
    // can support a terminal status, fenced against replacement in the same commit.
    const tombstone = z.strictObject({ pairingId: z.literal(captured.record.pairingId), generation: integer.nonnegative(), revoked: z.literal(true) }).safeParse(row?.data);
    return row && tombstone.success && tombstone.data.generation > captured.record.requestSnapshot.principal.generation ? [store.check(key,row.rev)] : [];
  }
  async function requestedContext(captured: CapturedRequested): Promise<RequestedContextPlan> {
    const draft = captured.record.draftSnapshot;
    const repository = new DynamoRequestedFollowupRepository(store.options);
    const pairing = await input.auth.activePairing(captured.record.pairingId);
    if (pairing.data.generation !== captured.record.requestSnapshot.principal.generation) throw new Error('requested_authority_changed');
    const context = await repository.readContext({ accountId: draft.accountId, originalCall: draft.originalCall, recipientBinding: draft.recipientBinding,
      expectedAccountVersion: draft.accountVersion, mode: 'manual' });
    if (context.authority.data.authority.generation !== captured.record.authorityGeneration) throw new Error('requested_authority_changed');
    if (context.mailContext.inboundContextFingerprint !== captured.record.baselineMailContext.inboundContextFingerprint) throw new Error('requested_evidence_changed');
    const candidate = { ...draft, mailContext: context.mailContext };
    candidate.contextRevision = requestedFollowupContextRevision(candidate); validateRequestedDraftContext(candidate,context);
    const draftKey = requestedFollowupDraftKey(draft.accountId,draft.id); const storedDraft = await store.get<unknown>(draftKey);
    if (!storedDraft || fingerprint(requestedFollowupDraftSchema.parse(storedDraft.data)) !== fingerprint(draft)) throw new Error('requested_evidence_changed');
    return { ...context, checks: [...context.checks,store.check(pairingKey(captured.record.pairingId),pairing.rev),store.check(draftKey,storedDraft.rev)] };
  }
  async function requestedScope(captured: CapturedRequested, signal: AbortSignal): Promise<CapturedRequested> {
    let context = await requestedContext(captured); const original = captured.record.draftSnapshot;
    const scope = context.cursor?.data.scope ?? null;
    const scopeFingerprint = scope ? mailScopeFingerprint(scope) : null;
    if (!captured.record.scopePlan) {
      if (scopeFingerprint !== captured.record.baselineMailContext.scopeFingerprint) throw new Error('requested_evidence_changed');
      if (scope?.participantAddresses.includes(original.recipient) && context.mailContext.inboundContextRevision !== null) return captured;
      const retained = (await threads.retainedThreads(original.accountId)).filter(thread => thread.thread.mailboxSubject === original.mailboxSubject);
      const routes = context.account.routes.filter(route => route.channel === 'email' && route.accountId === original.accountId
        && !context.account.routes.some(newer => newer.id === route.id && newer.version > route.version));
      const desiredScope = mailAccountScopeSchema.parse({ version: 1, accountId: original.accountId, mailboxSubject: original.mailboxSubject,
        revision: (scope?.revision ?? 0) + 1, participantAddresses: [...new Set([...(scope?.participantAddresses ?? []),original.recipient,...routes.map(route => route.value),
          ...retained.flatMap(thread => thread.thread.messages.flatMap(message => [...message.from,...message.to,...message.cc]))].map(address => address.toLowerCase()).filter(address => address !== original.sender.toLowerCase()))].sort(),
        knownThreadIds: [...new Set([...(scope?.knownThreadIds ?? []),...retained.map(thread => thread.thread.providerThreadId)])].sort(), since: scope?.since ?? captured.record.requestSnapshot.recordedAt,
        approvedAt: captured.record.requestSnapshot.recordedAt });
      const record = requestedApprovalRecordSchema.parse({ ...captured.record, scopePlan: { expectedEnvelopeRevision: context.cursor?.rev ?? null, previousScopeFingerprint: scopeFingerprint, desiredScope } });
      signal.throwIfAborted();
      await store.transact([...captured.checks.filter(item => checkKey(item) !== requestedApprovalKey(record.commandId)),...context.checks,
        store.put(requestedApprovalKey(record.commandId),record,captured.revision)]);
      const refreshed = await loadRequestedApproval(store,record.commandId); if (!refreshed) throw new Error('requested_capture_missing'); captured = refreshed;
      context = await requestedContext(captured);
    }
    const plan = captured.record.scopePlan!; const currentScope = context.cursor?.data.scope ?? null;
    const currentFingerprint = currentScope ? mailScopeFingerprint(currentScope) : null;
    if (currentFingerprint === mailScopeFingerprint(plan.desiredScope)) return captured;
    if (currentFingerprint !== plan.previousScopeFingerprint) throw new Error('requested_evidence_changed');
    const authorityCheck = store.check(context.authority.key,context.authority.rev,executionAuthorityFields(context.authority.data));
    const cursorKey = mailCursorKey(original.accountId,original.mailboxSubject);
    const proof = [...captured.checks,...context.checks.filter(item => checkKey(item) !== context.authority.key && checkKey(item) !== cursorKey)];
    // C3 owns the scope write and semantic-revision rules. Its actual emitted AUTH
    // check must equal the baseline proof, and its cursor CAS must use the current
    // envelope. Only storage revision may refresh, never the immutable scope plan.
    const dynamo: DynamoAdapter = { async send(command) {
      if (!(command instanceof TransactWriteItemsCommand)) return store.options.dynamo.send(command);
      signal.throwIfAborted();
      const items = command.input.TransactItems ?? [];
      const auth = items.find(item => checkKey(item) === context.authority.key);
      const cursor = items.find(item => item.Put?.Item?.sk?.S === cursorKey)?.Put;
      if (fingerprint(auth) !== fingerprint(authorityCheck) || !cursor
        || (context.cursor ? cursor.ExpressionAttributeValues?.[':rev']?.N !== String(context.cursor.rev) : cursor.ConditionExpression !== 'attribute_not_exists(#pk)')) throw new Error('requested_evidence_changed');
      return store.options.dynamo.send(new TransactWriteItemsCommand({ ...command.input,TransactItems: [...items,...proof] }));
    } };
    await new DynamoThreadIntakeRepository({ ...store.options,dynamo }).admitScope(plan.desiredScope,context.cursor?.rev ?? null);
    return captured;
  }
  async function requestedMaterialized(commandId: string, signal: AbortSignal, report: SourceTickReport) {
    const intent = await policy.loadRequestedMaterializedIntent(commandId);
    const active = await source(intent.action.accountId); if (!active) return;
    if (intent.pairingId !== active.data.pairingId || intent.mailboxSubject !== active.data.mailboxSubject) throw new Error('requested_authority_changed');
    const action = await execution.readDispatch(intent.action.accountId,intent.action.actionId); if (!action) throw new Error('requested_materialized_action_missing');
    const fetch = boundFetch(signal); await unchanged(active); signal.throwIfAborted();
    if (action.reservation && !['provider_accepted','cancelled','human_reported_sent'].includes(action.state)) {
      await createSendReconciler({ execution,policy,authorization: input.authorization,fetch }).reconcileSend(intent.commandId,signal); report.sendReconciliations++;
    } else if (action.state === 'prepared' || action.state === 'queued') {
      const result = await createDispatchService({ execution,policy,authorization: input.authorization,fetch }).dispatch(intent.commandId,signal); report.dispatches++;
      if (result.status === 'held') hold(report, 'dispatch_held');
    }
  }
  async function resumeRequested(commandId: string, signal: AbortSignal, report: SourceTickReport) {
    let captured = await loadRequestedApproval(store,commandId); if (!captured) throw new Error('requested_capture_missing');
    if (captured.record.state === 'materialized') { await requestedMaterialized(commandId,signal,report); return; }
    if (captured.record.state !== 'pending_preflight') return;
    try {
      const authorityRow = await store.get<unknown>(executionAuthorityKey(captured.record.accountId)); if (!authorityRow) throw new Error('authority_missing');
      const authority = authorityRecordSchema.parse(authorityRow.data);
      if (authority.authority.state === 'revoked') throw new Error('requested_revoked');
      if ((await requestedPairingRevocation(captured)).length) throw new Error('requested_pairing_revoked');
      if (authority.authority.generation !== captured.record.authorityGeneration || authority.authority.owner !== 'worker') throw new Error('requested_authority_changed');
      if (Date.parse(store.now()) >= Date.parse(captured.record.expiresAt)) throw new Error('requested_expired');
      const configured = await store.get<unknown>(ownerSourceKey(captured.record.accountId)); if (!configured) throw new Error('requested_preflight_incomplete');
      const config = ownerSourceConfigurationSchema.parse(configured.data);
      if (config.workspaceId !== store.options.workspaceId || config.accountId !== captured.record.accountId || config.pairingId !== captured.record.pairingId
        || config.mailboxSubject !== captured.record.mailboxSubject) throw new Error('requested_authority_changed');
      if (authority.authority.state !== 'active' || config.state !== 'active') return;
      const pairing = await input.auth.activePairing(captured.record.pairingId);
      if (pairing.data.generation !== captured.record.requestSnapshot.principal.generation) throw new Error('requested_authority_changed');
      report.status = 'completed'; captured = await requestedScope(captured,signal);
      const poll = await poller.pollOnce({ accountId: captured.record.accountId,pairingId: captured.record.pairingId,mailboxSubject: captured.record.mailboxSubject },signal);
      if (poll.suppressed) throw new Error('requested_evidence_changed');
      await requestedContext(captured);
      if (!poll.complete) throw new Error('requested_preflight_incomplete');
      const plan = await policy.planRequestedAdmission(commandId);
      const action = await execution.planPrepareAction(plan.preparedInput,plan.authority.data);
      const next = { ...plan.authority.data,version: plan.authority.data.version + 1 };
      const outbox = await store.eventItems(workerEventSchema.parse({ id: `requested-materialized-${fingerprint([commandId,next.version])}`,workspaceId: store.options.workspaceId,
        accountId: captured.record.accountId,authorityGeneration: next.authority.generation,aggregateVersion: next.version,kind: 'requested_followup.status',
        payload: { commandId,draftId: captured.record.draftSnapshot.id,status: { receipt: captured.receipt,state: 'materialized',intentCommandId: plan.intent.commandId,reason: null } },
        ...(plan.campaign ? { campaign: plan.campaign } : {}) }));
      signal.throwIfAborted(); if (Date.parse(store.now()) >= plan.validUntil) throw new Error('requested_expired');
      await store.transact([...plan.items,...action.items,store.put(plan.authority.key,next,plan.authority.rev,executionAuthorityFields(next),executionAuthorityFields(plan.authority.data)),...outbox.items]);
    } catch (error) {
      // A lost final-commit response is reconciled from exact immutable materialized
      // keys below. Never replay the original now-stale owner command or admissions.
      const current = await loadRequestedApproval(store,commandId); if (!current) throw error; captured = current;
      if (current.record.state !== 'materialized') {
        const revocation = await requestedPairingRevocation(current);
        const reason = revocation.length ? 'requested_pairing_revoked' : error instanceof Error ? error.message : '';
        const terminal = reason === 'requested_expired' ? 'expired' : (reason === 'requested_revoked' || revocation.length > 0) ? 'revoked'
          : ['requested_evidence_changed','requested_authority_changed','requested_capture_conflict','requested_context_stale','requested_account_stale','requested_route_stale',
            'requested_call_evidence_invalid','requested_call_pairing_mismatch','requested_call_not_applied','requested_call_receipt_mismatch','requested_mailbox_mismatch','requested_suppressed','requested_draft_identity_conflict',
            'requested_mail_context_stale','requested_recipient_mismatch','requested_wrong_authority','campaign_requested_followup_origin','campaign_requested_followup_held'].includes(reason) ? 'needs_review' : 'pending_preflight';
        await requestedStatus(current,terminal,terminal === 'pending_preflight' ? 'requested_preflight_incomplete' : reason,revocation); hold(report, 'requested_followup_held'); return;
      }
    }
    await requestedMaterialized(commandId,signal,report);
  }
  function boundFetch(signal: AbortSignal): typeof globalThis.fetch {
    return (resource, init) => input.fetch(resource, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
  }
  async function configurations(signal: AbortSignal, report: SourceTickReport) {
    const fetch = boundFetch(signal);
      const configs = await page('OWNER_SOURCE#');
      for (const row of configs.rows) {
        signal.throwIfAborted();
        await configs.advance(row.key);
        try {
          const parsed = ownerSourceConfigurationSchema.parse(row.data);
          if (row.key !== ownerSourceKey(parsed.accountId)) throw new Error('source_identity_mismatch');
          const active = await source(parsed.accountId); if (!active) continue;
          report.status = 'completed';
          if (active.data.mailboxSubject !== null) {
            const config = await unchanged(active);
            await poller.pollOnce({ accountId: config.accountId, pairingId: config.pairingId, mailboxSubject: config.mailboxSubject! }, signal);
            report.mailPolls++;
          }
          await meetings(active, signal, fetch, report);
        } catch { hold(report, 'configuration_failed'); }
      }
      signal.throwIfAborted();
      await configs.advance();
  }
  async function submittedCommands(signal: AbortSignal, report: SourceTickReport) {
    const fetch = boundFetch(signal);
    const dispatch = createDispatchService({ execution, policy, authorization: input.authorization, fetch });
    const reconciler = createSendReconciler({ execution, policy, authorization: input.authorization, fetch });
      const commands = await page('COMMAND#');
      for (const row of commands.rows) {
        signal.throwIfAborted();
        await commands.advance(row.key);
        const parsed = submittedSchema.safeParse(row.data);
        if (!parsed.success || !['submit-approved-reply', 'approve-reply', 'approve-requested-followup'].includes(parsed.data.command.kind)) continue;
        try {
          const { command, receipt } = parsed.data;
          if (row.key !== `COMMAND#${keyPart(command.commandId)}` || command.workspaceId !== store.options.workspaceId
            || parsed.data.fingerprint !== fingerprint(command) || receipt.commandId !== command.commandId || receipt.status !== 'applied'
            || receipt.authorityGeneration !== command.expectedAuthorityGeneration || receipt.aggregateVersion !== command.expectedVersion + 1) throw new Error('source_command_mismatch');
          if (command.kind === 'approve-requested-followup') { await resumeRequested(command.commandId,signal,report); continue; }
          if (command.kind !== 'submit-approved-reply' && command.kind !== 'approve-reply') continue;
          const active = await source(command.accountId); if (!active) continue;
          const intent = await policy.loadIntent(command.payload.intentCommandId);
          if (!intent || intent.commandId !== command.payload.intentCommandId || intent.action.accountId !== command.accountId
            || intent.action.workspaceId !== command.workspaceId || intent.pairingId !== active.data.pairingId || intent.mailboxSubject !== active.data.mailboxSubject
            || intent.action.expectedAuthorityGeneration !== command.expectedAuthorityGeneration) throw new Error('source_intent_mismatch');
          const action = await execution.readDispatch(command.accountId, intent.action.actionId); if (!action) throw new Error('source_action_missing');
          if (command.kind === 'approve-reply') {
            const scheduling = command.payload.schedulingOffer;
            if (!scheduling || action.state !== 'provider_accepted') continue;
            if (intent.action.actionId !== command.payload.actionId || intent.action.approvalId !== command.payload.approvalId) throw new Error('source_approval_mismatch');
            await unchanged(active); signal.throwIfAborted();
            const previous = await store.get<unknown>(meetingOfferKey(command.accountId, scheduling.offer.threadId));
            if (previous) {
              const offer = meetingOfferSchema.parse(previous.data);
              if (offer.revision > scheduling.offer.revision) continue;
              if (offer.revision === scheduling.offer.revision) {
                if (fingerprint(offer) !== fingerprint(scheduling.offer)) throw new Error('source_offer_conflict');
                continue;
              }
            }
            await new DynamoMeetingRepository(store.options, input.authorization).saveOffer(scheduling);
            continue;
          }
          if (['provider_accepted', 'cancelled', 'human_reported_sent'].includes(action.state)) continue;
          await unchanged(active); signal.throwIfAborted(); report.status = 'completed';
          if (action.reservation || action.state === 'dispatching' || action.state === 'unknown') {
            await reconciler.reconcileSend(intent.commandId, signal); report.sendReconciliations++;
          } else if (action.state === 'prepared' || action.state === 'queued') {
            const result = await dispatch.dispatch(intent.commandId, signal); report.dispatches++;
            if (result.status === 'held') hold(report, 'dispatch_held');
          }
        } catch { hold(report, 'command_failed'); }
      }
      signal.throwIfAborted();
      await commands.advance();
  }
  /** The tick's own record row. Written after the phases, fenced on its own revision; a lost write holds the tick but never repeats a phase. */
  async function persistLastTick(report: SourceTickReport, startedAt: number): Promise<void> {
    const row = await store.get<unknown>(SOURCE_LAST_TICK_KEY);
    const record = buildScheduledRunRecord(report, { at: store.now(), durationMs: Date.now() - startedAt });
    await store.transact([store.put(SOURCE_LAST_TICK_KEY, record, row?.rev ?? null)]);
  }
  return { async tick(callerSignal: AbortSignal): Promise<SourceTickReport> {
    const startedAt = Date.now();
    const report = emptyTickReport();
    if (callerSignal.aborted) return { ...report, status: 'aborted' };
    const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), TICK_DEADLINE_MS);
    const signal = AbortSignal.any([callerSignal, deadline.signal]);
    const phases = [research, configurations, submittedCommands, publications, territoryBackfill] as const;
    const phaseNames: readonly TickPhase[] = ['research', 'configurations', 'submittedCommands', 'publications', 'territoryBackfill'];
    const phaseFailures: readonly TickHeldReason[] = ['research_phase_failed', 'configurations_phase_failed', 'commands_phase_failed', 'publications_phase_failed', 'territory_phase_failed'];
    const key = 'SOURCE_PHASE_CURSOR';
    try {
      const row = await store.get<unknown>(key);
      const start = row ? z.strictObject({ next: integer.max(phases.length - 1) }).parse(row.data).next : 0;
      let revision = row?.rev ?? null;
      for (let turn = 0; turn < phases.length; turn++) {
        signal.throwIfAborted();
        const index = (start + turn) % phases.length;
        // Persist the next turn BEFORE IO. Crash/timeout advances fairness only,
        // never a receipt, authority, or permission to resend reserved work.
        await store.transact([store.put(key, { next: (index + 1) % phases.length }, revision)]);
        revision = (revision ?? 0) + 1;
        const phaseDeadline = new AbortController(); const phaseTimer = setTimeout(() => phaseDeadline.abort(), PHASE_SLICES_MS[index] ?? 10000);
        const phaseSignal = AbortSignal.any([signal, phaseDeadline.signal]);
        const name = phaseNames[index]!;
        const phaseStartedAt = Date.now();
        try { await phases[index]!(phaseSignal, report); report.phases[name] = phaseSignal.aborted ? 'aborted' : 'completed'; }
        catch { report.phases[name] = signal.aborted ? 'aborted' : 'held'; hold(report, phaseFailures[index]!); }
        finally { clearTimeout(phaseTimer); }
        await recordAttempt(store, phaseAttempt(name, report, phaseFailures[index]!, Date.now() - phaseStartedAt));
      }
    } catch { if (!signal.aborted) hold(report, 'tick_failed'); }
    finally { clearTimeout(timer); }
    for (const name of phaseNames) report.phases[name] ??= 'skipped';
    if (signal.aborted) report.status = 'aborted';
    // The record is written outside the tick deadline: a slow tick still leaves its last-run evidence for Settings and the log.
    try { await persistLastTick(report, startedAt); }
    catch { hold(report, 'tick_record_write_failed'); }
    await recordAttempt(store, tickAttempt(report, Date.now() - startedAt));
    return report;
  } };
}

/** One `tick_phase` attempt (S0 diagnostics): the phase's outcome, the closed reason it named or the failure it counted, and its error class. */
function phaseAttempt(name: TickPhase, report: SourceTickReport, failure: TickHeldReason, durationMs: number): AttemptInput {
  const result = report.phases[name]; const held = report.phaseHolds[name];
  const outcome = result === 'completed' ? 'ok' : result === 'aborted' ? 'aborted' : 'held';
  const reason = outcome === 'ok' ? null : held?.reason ?? (outcome === 'held' ? failure : 'deadline');
  return { kind: 'tick_phase', outcome, reason, detail: held?.errorClass ? `errorClass=${held.errorClass}` : null, durationMs, ref: name };
}
/** One `tick` attempt per run: counts only, the most frequent hold reason when held, and the run's duration. */
function tickAttempt(report: SourceTickReport, durationMs: number): AttemptInput {
  const outcome = report.status === 'aborted' ? 'aborted' : report.held > 0 ? 'held' : 'ok';
  const reasons = (Object.entries(report.heldByReason) as [TickHeldReason, number][]).sort((a, b) => b[1] - a[1]);
  const reason = outcome === 'ok' ? null : reasons[0]?.[0] ?? (outcome === 'aborted' ? 'deadline' : null);
  const detail = `status=${report.status} held=${report.held} polls=${report.mailPolls} dispatches=${report.dispatches} research=${report.researchCompleted}`
    + (report.places ? ` places=${report.places.outcome}` : '') + (report.territory ? ` swept=${report.territory.scanned}` : '')
    + (report.sequenceEmails ? ` emails_sent=${report.sequenceEmails.sent} emails_held=${report.sequenceEmails.held}` : '');
  return { kind: 'tick', outcome, reason, detail, durationMs, ref: null };
}
