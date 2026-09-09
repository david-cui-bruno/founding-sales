import { QueryCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { ownerCommandSchema, ownerResearchSourceSchema, ownerResearchSourceKey, ownerSourceConfigurationSchema, ownerSourceKey, type OwnerSourceConfiguration } from '../../../../src/shared/contracts/ownerCommandContract';
import { commandReceiptSchema } from '../../../../src/shared/contracts/delegationContract';
import { pairingKey, type WorkerAuth } from './workerAuth';
import type { RemoteGoogleAuthorization } from './remoteGoogleAuthorization';
import { fingerprint, integer, keyPart, type Stored, type DynamoAdapter } from './dynamoStore';
import { DynamoThreadIntakeRepository } from './threadIntakeRepository';
import { createMailPoller } from './mailPoller';
import { DynamoDispatchRepository } from './dispatchRepository';
import { createExecutionRepository } from './executionRepository';
import { CampaignExecution } from './campaignExecution';
import { WorkerCampaignRepository } from './workerCampaignRepository';
import { createDispatchService } from './dispatchService';
import { createSendReconciler } from './sendReconciler';
import { createCompanyPageProvider, type PageHttp } from '../../../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../../../src/main/research/companySourcePolicy';
import { createCompanyPreparation, createCompanyResearchWorker } from '../../../../src/main/research/companyResearchWorker';
import { createCompanyDiscoveryProvider, requestCompanyDiscovery } from '../../../../src/main/research/companyDiscoveryProvider';
import { createWorkerAccountRepository } from './workerAccountRepository';
import { createDiscoveryReservationStore } from './discoveryReservationStore';
import { DynamoMeetingRepository, meetingOfferKey } from './meetingRepository';
import { meetingOfferSchema } from '../../../../src/shared/contracts/meetingContract';
import { MeetingCoordinator } from './meetingCoordinator';

export type SourceResearchBoundaries = { loadCredentials(workspaceId: string, signal: AbortSignal): Promise<{ apiKey: string; model: string }>;
  pageHttp: PageHttp; resolve(hostname: string): Promise<string[]> };
export type SourceCoordinatorOptions = { auth: WorkerAuth; authorization: RemoteGoogleAuthorization; fetch: typeof globalThis.fetch; research?: SourceResearchBoundaries };
export type SourceTickReport = { status: 'inactive' | 'completed' | 'aborted'; researchPrepared: number; researchCompleted: number;
  mailPolls: number; dispatches: number; sendReconciliations: number; meetings: number; held: number };
const PAGE_LIMIT = 25;
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
    return { rows, async advance() {
      if (rows.length || after || next) await store.transact([store.put(cursorKey, { after: next }, cursor?.rev ?? null)]);
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
    const boundaries = input.research; if (!boundaries) return;
    const row = await store.get<unknown>(ownerResearchSourceKey()); if (!row) return;
    const config = ownerResearchSourceSchema.parse(row.data);
    if (config.workspaceId !== store.options.workspaceId || config.state !== 'active' || !config.research) return;
    const settings = config.research;
    if (settings.workspaceId !== config.workspaceId || settings.researchLimits.maxCostMicros > settings.maxAccountBudgetMicros) throw new Error('research_config_mismatch');
    const pairing = await input.auth.activePairing(config.pairingId);
    async function guard() {
      signal.throwIfAborted();
      const current = await store.get<unknown>(ownerResearchSourceKey());
      if (!current || current.rev !== row!.rev || fingerprint(current.data) !== fingerprint(config)) throw new Error('research_source_changed');
      const active = await input.auth.activePairing(config.pairingId);
      if (active.rev !== pairing.rev) throw new Error('research_pairing_changed');
    }
    // The SDK boundary adds actual config and pairing CAS to every C1 mutation.
    // Reading a selector cannot approve budget, grant AUTH, or reset unknown spend.
    const dynamo: DynamoAdapter = { async send(command) {
      if (!(command instanceof TransactWriteItemsCommand)) return store.options.dynamo.send(command);
      await guard();
      return store.options.dynamo.send(new TransactWriteItemsCommand({ ...command.input, TransactItems: [...(command.input.TransactItems ?? []),
        store.check(ownerResearchSourceKey(), row.rev), store.check(pairingKey(config.pairingId), pairing.rev)] }));
    } };
    const options = { ...store.options, dynamo };
    const accounts = createWorkerAccountRepository(options);
    const reservations = createDiscoveryReservationStore(options);
    const discovery = createCompanyDiscoveryProvider({ capability: settings.capability, request: async (query, limits, requestSignal) => {
      await guard(); const credentials = await boundaries.loadCredentials(config.workspaceId, requestSignal);
      await guard();
      if (credentials.model !== settings.capability.model) throw new Error('research_model_mismatch');
      return requestCompanyDiscovery({ query, limits, capability: settings.capability, credentials, signal: requestSignal, fetch: input.fetch });
    } });
    const identity = fingerprint({ workspaceId: config.workspaceId, pairingId: config.pairingId, research: settings });
    const runId = `${identity.slice(0,8)}-${identity.slice(8,12)}-4${identity.slice(13,16)}-a${identity.slice(17,20)}-${identity.slice(20,32)}`;
    const prepared = await createCompanyPreparation({ store: accounts, reservations, discovery, configuration: settings }).prepare(runId, signal);
    report.status = 'completed';
    if (prepared.status !== 'prepared') { report.held++; return; }
    report.researchPrepared++;
    const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: options.clock,
      permitted: (url) => settings.permittedSources.includes(url),
      resolve: async hostname => { await guard(); return boundaries.resolve(hostname); },
      http: async request => { await guard(); return boundaries.pageHttp(request); },
      onFetched: (source, accountId) => accounts.recordFetchedSource({ accountId, source }) });
    const worker = createCompanyResearchWorker({ store: accounts, clock: options.clock, pages: { async research(snapshot, limits, requestSignal) {
      await guard();
      if (!prepared.accountIds.includes(snapshot.account.id) || fingerprint(limits) !== fingerprint(settings.researchLimits)) throw new Error('research_job_config_mismatch');
      return pages.research(snapshot, limits, requestSignal);
    } } });
    const result = await worker.runNext(signal);
    if (result === 'completed') report.researchCompleted++;
    if (result === 'parked') report.held++;
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
    const offersCursor = await meetingCursor(config.accountId, 'offers');
    const offers = await repository.listAcceptedOffers(config.accountId, offersCursor.after, PAGE_LIMIT);
    for (const offer of offers.offers) { signal.throwIfAborted(); await unchanged(active);
      await repository.prepareOfferedReply({ accountId: config.accountId, threadId: offer.threadId }); }
    await offersCursor.advance(offers.nextCursor);
    const workCursor = await meetingCursor(config.accountId, 'work');
    const work = await repository.listPreparedIntents(config.accountId, workCursor.after, PAGE_LIMIT);
    const processed = new Set<string>();
    for (const item of work.work) { signal.throwIfAborted(); await unchanged(active);
      if (item.input.calendarId !== config.calendarId || item.input.intent.pairingId !== config.pairingId || item.input.intent.mailboxSubject !== config.mailboxSubject) continue;
      const result = await coordinator.coordinateMeeting(item.input.intent, signal); processed.add(item.input.intent.commandId); report.meetings++;
      if (result.status === 'held' || result.status === 'unknown') report.held++;
    }
    await workCursor.advance(work.nextCursor);
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
  return { async tick(callerSignal: AbortSignal): Promise<SourceTickReport> {
    const report: SourceTickReport = { status: 'inactive', researchPrepared: 0, researchCompleted: 0, mailPolls: 0, dispatches: 0,
      sendReconciliations: 0, meetings: 0, held: 0 };
    if (callerSignal.aborted) return { ...report, status: 'aborted' };
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(45000)]);
    const fetch: typeof globalThis.fetch = (resource, init) => input.fetch(resource, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
    const dispatch = createDispatchService({ execution, policy, authorization: input.authorization, fetch });
    const reconciler = createSendReconciler({ execution, policy, authorization: input.authorization, fetch });
    try {
      try { await research(signal, report); } catch { report.held++; }
      const configs = await page('OWNER_SOURCE#');
      for (const row of configs.rows) {
        signal.throwIfAborted();
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
        } catch { report.held++; }
      }
      await configs.advance();
      const commands = await page('COMMAND#');
      for (const row of commands.rows) {
        signal.throwIfAborted();
        const parsed = submittedSchema.safeParse(row.data);
        if (!parsed.success || !['submit-approved-reply', 'approve-reply'].includes(parsed.data.command.kind)) continue;
        try {
          const { command, receipt } = parsed.data;
          if (row.key !== `COMMAND#${keyPart(command.commandId)}` || command.workspaceId !== store.options.workspaceId
            || parsed.data.fingerprint !== fingerprint(command) || receipt.commandId !== command.commandId || receipt.status !== 'applied'
            || receipt.authorityGeneration !== command.expectedAuthorityGeneration || receipt.aggregateVersion !== command.expectedVersion + 1) throw new Error('source_command_mismatch');
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
            await reconciler.reconcileSend(intent.commandId); report.sendReconciliations++;
          } else if (action.state === 'prepared' || action.state === 'queued') {
            const result = await dispatch.dispatch(intent.commandId); report.dispatches++;
            if (result.status === 'held') report.held++;
          }
        } catch { report.held++; }
      }
      await commands.advance();
      await publications(signal);
    } catch { if (!signal.aborted) report.held++; }
    if (signal.aborted) report.status = 'aborted';
    return report;
  } };
}
