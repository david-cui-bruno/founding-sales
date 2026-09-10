import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { checkFts5, closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { inspectDatabaseEncryption } from '../../src/main/db/databaseEncryption';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain, type FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { readWorkflowMode } from '../../src/main/domain/workspace/legacyWorkflowTransition';
import { registerApplicationIpc } from '../../src/main/ipc/registerApplicationIpc';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import type { CallieApi } from '../../src/preload/createCallieApi';
import type { IpcInvoker } from '../../src/preload/ipcClient';
import type { OutreachApi } from '../../src/shared/contracts/outreachContract';
import { leadsListRequestSchema, leadFieldUpdateRequestSchema, leadBulkUpdateRequestSchema,
  type LeadsListRequest, type LeadFieldUpdateRequest, type LeadBulkUpdateRequest } from '../../src/shared/contracts/leadsContract';
import { reviewListRequestSchema, type ReviewListRequest } from '../../src/shared/contracts/reviewContract';
import { confirmTransitionRequestSchema, dismissLeadRequestSchema, leadDetailRequestSchema, leadDetailSchema,
  type ConfirmTransitionRequest, type DismissLeadRequest, type LeadDetailRequest } from '../../src/shared/contracts/leadDetailContract';
import { insertClosedCycle, insertOpenCycleWithAction, insertSourceEvent, seedProspect } from './domainRows';
import type { RegisteredIpcHandler } from './registeredIpcHandler';
import { createTempDatabase, createTestWorkspaceKey } from './tempDatabase';

export const RELIABILITY_NOW = '2026-08-31T17:00:00.000Z';
export const RELIABILITY_URL = 'callie://app/index.html';
const TABLES = ['lifecycle_review_items', 'cycle_reactivation_receipts', 'persons', 'prospects',
  'person_contact_methods', 'source_events', 'sales_cycles', 'next_actions', 'activities', 'stage_events',
  'organizations', 'organization_aliases', 'properties', 'prospect_organizations', 'prospect_properties'] as const;

type Phase = 'setup' | 'ui' | 'probe';
export type ReliabilityTrace = Readonly<{
  id: number; phase: Phase; channel: string; args: readonly unknown[];
  handlerStarted: boolean; handlerSettled?: boolean; deliveryHeld?: boolean;
  outcome: 'pending' | 'resolved' | 'rejected';
  result?: unknown; error?: string;
}>;
export type CleanupEvidence = Readonly<{
  databaseClosed: boolean; keyZeroed: boolean; temporaryDirectoryRemoved: boolean;
  registrationsRemaining: number; pendingInvocations: number; externalInvocations: number;
}>;
export type ReviewOwner = Readonly<{
  reviewId: string; activationKey: string; kind: 'system_error' | 'unmatched_communication';
  personId: string; prospectId: string; sourceCycleId: string; newCycleId: string;
}>;
type StoredReview = {
  reviewId: string; activationKey: string; status: string; reason: string; version: number;
  resolution: string | null; resolvedAt: string | null; createdAt: string;
  personId: string; prospectId: string; sourceCycleId: string;
  prospectPersonId: string; cyclePersonId: string; cycleProspectId: string;
};
type ImportedOwner = {
  personId: string; prospectId: string; salesCycleId: string; name: string; email: string;
  stage: string; workflowStatus: string; sourceChannel: string; actionId: string | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Rejection remains observable by its owner, including teardown-before-await.
  void promise.catch((): undefined => undefined);
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
type DeliveryState = 'waiting' | 'claimed' | 'arrived' | 'released' | 'rejected' | 'cancelled';
type ReviewHold = {
  request: ReviewListRequest; remaining: number; state: DeliveryState;
  arrival: ReturnType<typeof deferred<ReliabilityTrace>>;
  delivery: ReturnType<typeof deferred<void>>;
};
export type LeadsControl =
  | { channel: 'leads:list'; request: LeadsListRequest; at: 'after-handler' }
  | { channel: 'leads:update-field'; request: LeadFieldUpdateRequest; at: 'before-handler' }
  | { channel: 'leads:bulk-update'; request: LeadBulkUpdateRequest; at: 'before-handler' };
type LeadsHold = {
  control: LeadsControl; remaining: number; state: DeliveryState;
  arrival: ReturnType<typeof deferred<ReliabilityTrace>>;
  delivery: ReturnType<typeof deferred<void>>;
};
type OrganizationAssignment = {
  personId: string; prospectId: string; organizationId: string; canonicalName: string; relationship: string | null;
};
export type ReviewDecisionControl =
  | { channel: 'lead-detail:confirm-transition'; at: 'before-handler';
      request: Extract<ConfirmTransitionRequest, { transition: 'review_to_ready' }> }
  | { channel: 'lead-detail:dismiss'; at: 'before-handler'; request: DismissLeadRequest };
type DetailControl = { channel: 'lead-detail:get'; at: 'after-handler'; request: LeadDetailRequest };
type DecisionHold = {
  control: ReviewDecisionControl | DetailControl; remaining: number; state: DeliveryState;
  arrival: ReturnType<typeof deferred<ReliabilityTrace>>;
  delivery: ReturnType<typeof deferred<void>>;
};
type DecisionRelation = { personId: string; prospectId: string; salesCycleId: string } & Record<string, unknown>;

function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}

/** Native SQL fixture, NOT FoundationRuntime startup/locking or a browser harness.
 * The caller owns an otherwise empty Electron transport map. No raw DB/key escapes.
 * Finite exact read-delivery/mutation-admission holds never replace handler results.
 */
export async function createReliabilityDomainFixture(
  handlers: Map<string, RegisteredIpcHandler>,
  onDisposed?: (evidence: CleanupEvidence) => void,
) {
  assert.equal(handlers.size, 0, 'The fixture requires an unowned, empty transport map');
  const temp = createTempDatabase();
  const key = createTestWorkspaceKey();
  const temporaryDirectory = dirname(dirname(temp.path));
  let database: AppDatabase | undefined;
  let disposed = false;
  let disposal: Promise<CleanupEvidence> | undefined;
  let delegation: ReturnType<typeof createDelegationRuntime> | undefined;
  let externalInvocations = 0;
  let domainEntries = 0;
  let databaseEntries = 0;
  let phase: Phase = 'setup';
  const unregisters: (() => void)[] = [];
  const flights = new Set<Promise<unknown>>();
  const entries: ReliabilityTrace[] = [];
  const holds: ReviewHold[] = [];
  const leadsHolds: LeadsHold[] = [];
  const decisionHolds: DecisionHold[] = [];
  const importedPersonIds = new Set<string>();
  const seededReviews = new Map<string, ReviewOwner>();
  const requireOpen = () => {
    if (disposed || database === undefined || !database.raw.open) throw new Error('RELIABILITY_FIXTURE_DISPOSED');
    return database;
  };
  const forbidden = async (): Promise<never> => {
    externalInvocations += 1;
    throw new Error('EXTERNAL_CAPABILITY_UNAVAILABLE_IN_RELIABILITY_FIXTURE');
  };
  const idle = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...flights]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture invocation drain timed out')), 5_000); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const dispose = (): Promise<CleanupEvidence> => {
    if (disposal !== undefined) return disposal;
    disposed = true;
    disposal = (async () => {
      const errors: unknown[] = [];
      for (const hold of holds) {
        if (hold.state === 'waiting') errors.push(new Error('UNUSED_REVIEW_DELIVERY_HOLD'));
        if (['waiting', 'claimed', 'arrived'].includes(hold.state)) {
          hold.state = 'cancelled';
          hold.arrival.reject(new Error('REVIEW_DELIVERY_CANCELLED'));
          hold.delivery.reject(new Error('REVIEW_DELIVERY_CANCELLED'));
        }
      }
      for (const hold of leadsHolds) {
        if (hold.state === 'waiting') errors.push(new Error('UNUSED_LEADS_CONTROL'));
        if (['waiting', 'claimed', 'arrived'].includes(hold.state)) {
          hold.state = 'cancelled';
          hold.arrival.reject(new Error('LEADS_CONTROL_CANCELLED'));
          hold.delivery.reject(new Error('LEADS_CONTROL_CANCELLED'));
        }
      }
      for (const hold of decisionHolds) {
        if (hold.state === 'waiting') errors.push(new Error('UNUSED_DECISION_CONTROL'));
        if (['waiting', 'claimed', 'arrived'].includes(hold.state)) {
          hold.state = 'cancelled';
          hold.arrival.reject(new Error('DECISION_CONTROL_CANCELLED'));
          hold.delivery.reject(new Error('DECISION_CONTROL_CANCELLED'));
        }
      }
      try { await idle(); } catch (error) { errors.push(error); }
      try { await delegation?.dispose(); } catch (error) { errors.push(error); }
      for (const unregister of unregisters.splice(0).reverse()) {
        try { unregister(); } catch (error) { errors.push(error); }
      }
      // This map was exclusively empty at admission. Clear a partial registrar's
      // leaked transport entries for isolation, but report the cleanup defect.
      if (handlers.size !== 0) {
        errors.push(new Error(`Fixture registrar cleanup left ${handlers.size} handlers`));
        handlers.clear();
      }
      try { if (database !== undefined) closeDatabase(database); } catch (error) { errors.push(error); }
      key.bytes.fill(0);
      try { temp.cleanup(); } catch (error) { errors.push(error); }
      const evidence = Object.freeze({
        databaseClosed: database === undefined || !database.raw.open,
        keyZeroed: key.bytes.every(byte => byte === 0),
        temporaryDirectoryRemoved: !existsSync(temporaryDirectory),
        registrationsRemaining: handlers.size, pendingInvocations: flights.size, externalInvocations,
      });
      try { onDisposed?.(evidence); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, 'Reliability fixture cleanup failed');
      return evidence;
    })();
    return disposal;
  };

  try {
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    const clock = { now: () => RELIABILITY_NOW };
    let sequence = 0;
    const ids = { next: () => `reliability-generated-${String(++sequence).padStart(8, '0')}` };
    const services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => {
      const rule = services.prioritizationRepository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.prioritizationRepository.activateRuleVersion({ ruleVersionId: rule.id, expectedActiveRuleVersionId: null });
      services.cadences.installBuiltins();
    });
    const domain = createFounderSalesDomain({ database, services, clock, ids });
    // Test admission only. Actual FoundationRuntime readiness/locking is not replaced or claimed.
    const gate = {
      async withDomain<T>(operation: (value: FounderSalesDomain) => T | Promise<T>): Promise<T> {
        requireOpen(); domainEntries += 1; return operation(domain);
      },
      async withDatabase<T>(operation: (value: AppDatabase) => T | Promise<T>): Promise<T> {
        const current = requireOpen(); databaseEntries += 1; return operation(current);
      },
      async getHealth(): Promise<never> { throw new Error('Step A does not claim a FoundationRuntime health audit'); },
    };
    // The whole shipped mapping avoids copying individual provider bodies, including
    // Discovery's per-invocation gate. Unused external features reject explicitly.
    unregisters.push(registerApplicationIpc(gate, undefined, undefined,
      { pollNow: forbidden, status: forbidden, retry: forbidden, setHmacSalt: forbidden },
      { status: forbidden, beginSetup: forbidden, saveSetupMaterial: forbidden, completeSetup: forbidden, selectAndRunRestoreDrill: forbidden },
      { revealDatabase: forbidden, revealLogDirectory: forbidden },
    ));
    delegation = createDelegationRuntime({ databaseGate: gate, pairing: null, clock, fetch: forbidden });
    const outreach: OutreachApi = { status: forbidden, configure: forbidden, connectGmail: forbidden,
      disconnectGmail: forbidden, openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden, sendDraft: forbidden, inspectLocalAuthority: forbidden };
    unregisters.push(registerOutreachIpc({ provider: outreach, delegation }));

    const holdReviewList = (request: ReviewListRequest, occurrence = 1) => {
      requireOpen();
      assert.ok(Number.isSafeInteger(occurrence) && occurrence > 0);
      const parsed = frozenCopy(reviewListRequestSchema.parse(request));
      assert.ok(!holds.some(hold => hold.state === 'waiting' && hold.remaining === occurrence
        && isDeepStrictEqual(hold.request, parsed)), 'DUPLICATE_REVIEW_DELIVERY_HOLD');
      const hold: ReviewHold = { request: parsed, remaining: occurrence, state: 'waiting',
        arrival: deferred<ReliabilityTrace>(), delivery: deferred<void>() };
      holds.push(hold);
      const decide = (decision: 'released' | 'rejected' | 'cancelled') => {
        requireOpen();
        assert.equal(hold.state, 'arrived', 'REVIEW_DELIVERY_ALREADY_DECIDED_OR_NOT_ARRIVED');
        hold.state = decision;
        if (decision === 'released') hold.delivery.resolve();
        else hold.delivery.reject(new Error(decision === 'rejected' ? 'REVIEW_DELIVERY_REJECTED' : 'REVIEW_DELIVERY_CANCELLED'));
      };
      return Object.freeze({ arrived: () => bounded(hold.arrival.promise, 'Review delivery arrival'),
        release: () => decide('released'), rejectDelivery: () => decide('rejected'), cancel: () => decide('cancelled'),
        state: () => hold.state });
    };

    const holdLeads = <T extends LeadsControl>(control: T, occurrence = 1) => {
      requireOpen();
      assert.ok(Number.isSafeInteger(occurrence) && occurrence > 0);
      const parsed: LeadsControl = control.channel === 'leads:list'
        ? { channel: control.channel, at: 'after-handler', request: leadsListRequestSchema.parse(control.request) }
        : control.channel === 'leads:update-field'
          ? { channel: control.channel, at: 'before-handler', request: leadFieldUpdateRequestSchema.parse(control.request) }
          : { channel: control.channel, at: 'before-handler', request: leadBulkUpdateRequestSchema.parse(control.request) };
      assert.equal(control.at, parsed.at, 'LEADS_CONTROL_INVALID_PHASE');
      assert.ok(!leadsHolds.some(hold => hold.state === 'waiting' && hold.remaining === occurrence
        && isDeepStrictEqual(hold.control, parsed)), 'DUPLICATE_LEADS_CONTROL');
      const hold: LeadsHold = { control: frozenCopy(parsed), remaining: occurrence, state: 'waiting',
        arrival: deferred<ReliabilityTrace>(), delivery: deferred<void>() };
      leadsHolds.push(hold);
      const decide = (decision: 'released' | 'rejected' | 'cancelled') => {
        requireOpen();
        assert.equal(hold.state, 'arrived', 'LEADS_CONTROL_ALREADY_DECIDED_OR_NOT_ARRIVED');
        hold.state = decision;
        if (decision === 'released') hold.delivery.resolve();
        else hold.delivery.reject(new Error(decision === 'rejected' ? 'LEADS_DELIVERY_REJECTED' : 'LEADS_CONTROL_CANCELLED'));
      };
      const common = { arrived: () => bounded(hold.arrival.promise, 'Leads control arrival'),
        release: () => decide('released'), cancel: () => decide('cancelled'), state: () => hold.state };
      // A mutation hold cannot manufacture a post-handler rejection or replacement receipt.
      return Object.freeze(control.at === 'after-handler'
        ? { ...common, rejectDelivery: () => decide('rejected') } : common) as Readonly<typeof common &
          (T extends { at: 'after-handler' } ? { rejectDelivery(): void } : object)>;
    };

    // Only these three strict controls share internal lifetime mechanics. Old controls are unchanged.
    const holdDecision = <T extends ReviewDecisionControl | DetailControl>(control: T, occurrence: number) => {
      requireOpen();
      assert.ok(Number.isSafeInteger(occurrence) && occurrence > 0);
      let parsed: ReviewDecisionControl | DetailControl;
      if (control.channel === 'lead-detail:confirm-transition') {
        const request = confirmTransitionRequestSchema.parse(control.request);
        assert.equal(request.transition, 'review_to_ready', 'DECISION_CONTROL_UNSUPPORTED_TRANSITION');
        if (request.transition !== 'review_to_ready') throw new Error('DECISION_CONTROL_UNSUPPORTED_TRANSITION');
        parsed = { channel: control.channel, at: 'before-handler', request };
      } else if (control.channel === 'lead-detail:dismiss') {
        parsed = { channel: control.channel, at: 'before-handler', request: dismissLeadRequestSchema.parse(control.request) };
      } else if (control.channel === 'lead-detail:get') {
        parsed = { channel: control.channel, at: 'after-handler', request: leadDetailRequestSchema.parse(control.request) };
      } else throw new Error('DECISION_CONTROL_UNSUPPORTED_CHANNEL');
      assert.equal(control.at, parsed.at, 'DECISION_CONTROL_INVALID_PHASE');
      assert.ok(!decisionHolds.some(hold => isDeepStrictEqual(hold.control, parsed)
        && ((hold.state === 'waiting' && hold.remaining === occurrence)
          || hold.state === 'claimed' || hold.state === 'arrived')), 'DUPLICATE_DECISION_CONTROL');
      const hold: DecisionHold = { control: frozenCopy(parsed), remaining: occurrence, state: 'waiting',
        arrival: deferred<ReliabilityTrace>(), delivery: deferred<void>() };
      decisionHolds.push(hold);
      const decide = (decision: 'released' | 'rejected' | 'cancelled') => {
        requireOpen();
        assert.equal(hold.state, 'arrived', 'DECISION_CONTROL_ALREADY_DECIDED_OR_NOT_ARRIVED');
        hold.state = decision;
        if (decision === 'released') hold.delivery.resolve();
        else hold.delivery.reject(new Error(decision === 'rejected' ? 'NEXT_DETAIL_DELIVERY_REJECTED' : 'DECISION_CONTROL_CANCELLED'));
      };
      const common = { arrived: () => bounded(hold.arrival.promise, 'Decision control arrival'),
        release: () => decide('released'), cancel: () => decide('cancelled'), state: () => hold.state };
      return Object.freeze(parsed.at === 'after-handler' ? { ...common, rejectDelivery: () => decide('rejected') } : common) as
        Readonly<typeof common & (T extends DetailControl ? { rejectDelivery(): void } : object)>;
    };
    const holdReviewDecision = (control: ReviewDecisionControl, occurrence = 1) => {
      assert.ok(control.channel === 'lead-detail:confirm-transition' || control.channel === 'lead-detail:dismiss',
        'DECISION_CONTROL_UNSUPPORTED_CHANNEL');
      return holdDecision(control, occurrence);
    };
    const holdNextDetail = (request: LeadDetailRequest, occurrence = 1) =>
      holdDecision({ channel: 'lead-detail:get', at: 'after-handler', request }, occurrence);

    const invokeFrom = (url: string, channel: string, ...args: unknown[]): Promise<unknown> => {
      const index = entries.length;
      const initial = frozenCopy<ReliabilityTrace>({ id: index + 1, phase, channel, args, handlerStarted: false, outcome: 'pending' });
      entries.push(initial);
      const flight = (async () => {
        let delivery: ReviewHold | undefined;
        let leadControl: LeadsHold | undefined;
        let decisionControl: DecisionHold | undefined;
        try {
          requireOpen();
          const handler = handlers.get(channel);
          if (handler === undefined) throw new Error(`MISSING_RELIABILITY_HANDLER:${channel}`);
          if (channel === 'review:list' && url === RELIABILITY_URL && args.length === 1) {
            for (const hold of holds) {
              if (hold.state !== 'waiting' || !isDeepStrictEqual(hold.request, args[0])) continue;
              hold.remaining -= 1;
              if (hold.remaining === 0) { hold.state = 'claimed'; delivery = hold; }
            }
          }
          if (url === RELIABILITY_URL && args.length === 1) {
            for (const hold of leadsHolds) {
              if (hold.state !== 'waiting' || hold.control.channel !== channel || !isDeepStrictEqual(hold.control.request, args[0])) continue;
              hold.remaining -= 1;
              if (hold.remaining === 0) { hold.state = 'claimed'; leadControl = hold; }
            }
          }
          if (leadControl?.control.at === 'before-handler') {
            leadControl.state = 'arrived';
            leadControl.arrival.resolve(entries[index]!);
            await leadControl.delivery.promise;
            // Release can race immediate disposal. Recheck synchronously at forwarding,
            // not at the earlier terminal decision, so cancellation never mutates.
            requireOpen();
          }
          if (url === RELIABILITY_URL && args.length === 1) {
            for (const hold of decisionHolds) {
              if (hold.state !== 'waiting' || hold.control.channel !== channel || !isDeepStrictEqual(hold.control.request, args[0])) continue;
              hold.remaining -= 1;
              if (hold.remaining === 0) { hold.state = 'claimed'; decisionControl = hold; }
            }
          }
          if (decisionControl?.control.at === 'before-handler') {
            decisionControl.state = 'arrived';
            decisionControl.arrival.resolve(entries[index]!);
            await decisionControl.delivery.promise;
            requireOpen(); // Immediate disposal after release must still prevent forwarding.
          }
          entries[index] = frozenCopy({ ...initial, handlerStarted: true });
          const result = await handler({ senderFrame: { url } }, ...args);
          entries[index] = frozenCopy({ ...entries[index]!, handlerSettled: true, result });
          if (delivery !== undefined) {
            if (delivery.state === 'claimed') {
              delivery.state = 'arrived';
              entries[index] = frozenCopy({ ...entries[index]!, deliveryHeld: true });
              delivery.arrival.resolve(entries[index]!);
            }
            await delivery.delivery.promise;
          }
          if (leadControl?.control.at === 'after-handler') {
            if (leadControl.state === 'claimed') {
              leadControl.state = 'arrived';
              entries[index] = frozenCopy({ ...entries[index]!, deliveryHeld: true });
              leadControl.arrival.resolve(entries[index]!);
            }
            await leadControl.delivery.promise;
          }
          if (decisionControl?.control.at === 'after-handler') {
            leadDetailSchema.parse(result); // Validate the real settled result, never replace it.
            if (decisionControl.state === 'claimed') {
              decisionControl.state = 'arrived';
              entries[index] = frozenCopy({ ...entries[index]!, deliveryHeld: true });
              decisionControl.arrival.resolve(entries[index]!);
            }
            await decisionControl.delivery.promise;
          }
          entries[index] = frozenCopy({ ...entries[index]!, outcome: 'resolved', result });
          return result; // no enrichment, replacement receipt or response mutation
        } catch (error) {
          if (decisionControl?.state === 'claimed') {
            decisionControl.state = 'rejected';
            decisionControl.arrival.reject(new Error('DECISION_HANDLER_REJECTED_BEFORE_DELIVERY'));
          }
          if (leadControl?.state === 'claimed') {
            leadControl.state = 'rejected';
            leadControl.arrival.reject(new Error('LEADS_HANDLER_REJECTED_BEFORE_DELIVERY'));
          }
          if (delivery?.state === 'claimed') {
            delivery.state = 'rejected';
            delivery.arrival.reject(new Error('REVIEW_HANDLER_REJECTED_BEFORE_DELIVERY'));
          }
          entries[index] = frozenCopy({ ...entries[index]!, handlerSettled: entries[index]!.handlerStarted,
            outcome: 'rejected', error: error instanceof Error ? error.message : 'Unknown rejection' });
          throw error;
        }
      })();
      flights.add(flight);
      void flight.finally(() => flights.delete(flight)).catch((): undefined => undefined);
      return flight;
    };
    const invoker: IpcInvoker = { invoke: (channel, ...args) => invokeFrom(RELIABILITY_URL, channel, ...args) };
    const snapshot = () => {
      const current = requireOpen();
      return frozenCopy(Object.fromEntries(TABLES.map(table => [table,
        current.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ])));
    };
    const reviewOwners = (): StoredReview[] => requireOpen().raw.prepare<[], StoredReview>(`
      SELECT review.id AS reviewId, review.activation_key AS activationKey, review.status,
        review.reason, review.version, review.resolution_json AS resolution, review.resolved_at AS resolvedAt,
        review.created_at AS createdAt, review.person_id AS personId, review.prospect_id AS prospectId,
        review.source_cycle_id AS sourceCycleId, prospect.person_id AS prospectPersonId,
        cycle.person_id AS cyclePersonId, cycle.prospect_id AS cycleProspectId
      FROM lifecycle_review_items review JOIN persons person ON person.id = review.person_id
      JOIN prospects prospect ON prospect.id = review.prospect_id
      JOIN sales_cycles cycle ON cycle.id = review.source_cycle_id
      ORDER BY review.created_at, review.id
    `).all();
    const importedOwners = (): ImportedOwner[] => requireOpen().raw.prepare<[], ImportedOwner>(`
      SELECT person.id AS personId, prospect.id AS prospectId, cycle.id AS salesCycleId,
        person.display_name AS name, contact.normalized_value AS email, cycle.stage,
        cycle.workflow_status AS workflowStatus, source.channel AS sourceChannel,
        cycle.current_next_action_id AS actionId
      FROM persons person JOIN person_contact_methods contact ON contact.person_id = person.id AND contact.kind = 'email'
      JOIN prospects prospect ON prospect.person_id = person.id
      JOIN sales_cycles cycle ON cycle.prospect_id = prospect.id
      JOIN source_events source ON source.id = prospect.original_source_event_id
      ORDER BY person.display_name, person.id
    `).all();
    const organizationAssignments = (): OrganizationAssignment[] => requireOpen().raw.prepare<[], OrganizationAssignment>(`
      SELECT person.id AS personId, prospect.id AS prospectId, organization.id AS organizationId,
        organization.canonical_name AS canonicalName, membership.relationship
      FROM persons person JOIN prospects prospect ON prospect.person_id = person.id
      JOIN prospect_organizations membership ON membership.prospect_id = prospect.id
      JOIN organizations organization ON organization.id = membership.organization_id
      ORDER BY person.id, prospect.id, organization.id
    `).all().filter(row => importedPersonIds.has(row.personId));
    const reviewDecisionState = () => {
      const current = requireOpen();
      const owned = (rows: DecisionRelation[]) => rows.filter(row => importedPersonIds.has(row.personId));
      // Fixed joins retain each relation's own IDs and full persisted row, independent of DTOs.
      const owners = owned(current.raw.prepare<[], DecisionRelation>(`
        SELECT person.id AS personId, prospect.id AS prospectId, cycle.id AS salesCycleId,
          prospect.qualification_state, prospect.qualification_gate_reason, prospect.version AS prospectVersion,
          cycle.* FROM persons person
        JOIN prospects prospect ON prospect.person_id = person.id
        JOIN sales_cycles cycle ON cycle.prospect_id = prospect.id AND cycle.person_id = person.id
        ORDER BY person.id, cycle.id
      `).all());
      const enrollments = owned(current.raw.prepare<[], DecisionRelation>(`
        SELECT person.id AS personId, prospect.id AS prospectId, cycle.id AS salesCycleId,
          definition.family, definition.version AS definitionVersion, enrollment.*
        FROM persons person JOIN prospects prospect ON prospect.person_id = person.id
        JOIN sales_cycles cycle ON cycle.prospect_id = prospect.id AND cycle.person_id = person.id
        JOIN cadence_enrollments enrollment ON enrollment.sales_cycle_id = cycle.id
        JOIN cadence_definitions definition ON definition.id = enrollment.cadence_definition_id
        ORDER BY person.id, cycle.id, enrollment.id
      `).all());
      const actions = owned(current.raw.prepare<[], DecisionRelation>(`
        SELECT person.id AS personId, prospect.id AS prospectId, cycle.id AS salesCycleId,
          CASE WHEN cycle.current_next_action_id = action.id THEN 1 ELSE 0 END AS isCurrent, action.*
        FROM persons person JOIN prospects prospect ON prospect.person_id = person.id
        JOIN sales_cycles cycle ON cycle.prospect_id = prospect.id AND cycle.person_id = person.id
        JOIN next_actions action ON action.sales_cycle_id = cycle.id
        ORDER BY person.id, cycle.id, action.id
      `).all());
      const rules = owned(current.raw.prepare<[], DecisionRelation>(`
        SELECT person.id AS personId, prospect.id AS prospectId, cycle.id AS salesCycleId, rule.*
        FROM persons person JOIN prospects prospect ON prospect.person_id = person.id
        JOIN sales_cycles cycle ON cycle.prospect_id = prospect.id AND cycle.person_id = person.id
        JOIN reactivation_rules rule ON rule.sales_cycle_id = cycle.id
        ORDER BY person.id, cycle.id, rule.id
      `).all());
      const events = owned(current.raw.prepare<[], DecisionRelation>(`
        SELECT person.id AS personId, prospect.id AS prospectId, cycle.id AS salesCycleId, event.*
        FROM persons person JOIN prospects prospect ON prospect.person_id = person.id
        JOIN sales_cycles cycle ON cycle.prospect_id = prospect.id AND cycle.person_id = person.id
        JOIN stage_events event ON event.sales_cycle_id = cycle.id
        ORDER BY person.id, cycle.id, event.transition_sequence, event.id
      `).all());
      return frozenCopy({ owners, enrollments, actions, rules, events,
        jobs: current.raw.prepare('SELECT * FROM jobs ORDER BY id').all(), workflowMode: readWorkflowMode(current) });
    };
    return {
      invoker, invokeFrom, dispose, idle, holdReviewList, holdLeads,
      holdReviewDecision, holdNextDetail, reviewDecisionState,
      organizationAssignments: () => frozenCopy(organizationAssignments()),
      seedAmbiguousMembership(personId: string) {
        requireOpen();
        assert.ok(importedPersonIds.has(personId), 'Only an owned imported person may receive ambiguous membership');
        const owner = importedOwners().find(row => row.personId === personId);
        assert.ok(owner);
        assert.equal(organizationAssignments().filter(row => row.personId === personId).length, 1);
        services.unitOfWork.immediate(() => {
          const organization = services.identities.createOrganization({ canonicalName: `Fictional Second Organization ${personId}` });
          services.identities.linkOrganization({ prospectId: owner.prospectId, organizationId: organization.id });
        });
        return frozenCopy(organizationAssignments().filter(row => row.personId === personId));
      },
      setPhase(value: Phase) { phase = value; },
      trace: () => frozenCopy(entries),
      counts: () => Object.freeze({ domainEntries, databaseEntries, externalInvocations, pendingInvocations: flights.size }),
      snapshot, reviewOwners: () => frozenCopy(reviewOwners()), importedOwners: () => frozenCopy(importedOwners()),
      totalChanges: () => requireOpen().raw.prepare<[], { count: number }>('SELECT total_changes() AS count').get()!.count,
      constructionEvidence: () => {
        const current = requireOpen();
        return Object.freeze({ ...inspectDatabaseEncryption(current), fts5Available: checkFts5(current),
          schemaVersion: current.raw.prepare<[], { version: number }>('SELECT schema_version AS version FROM app_meta WHERE singleton = 1').get()!.version });
      },
      seedReviews(options: { majority?: ReviewOwner['kind']; tied?: boolean } = {}): readonly ReviewOwner[] {
        const current = requireOpen();
        assert.equal(reviewOwners().length, 0, 'Review scenario must start empty');
        const cadence = BUILTIN_CADENCES.find(value => value.family === 'cadence_c');
        assert.ok(cadence);
        const expected: ReviewOwner[] = [];
        for (let index = 0; index < 208; index += 1) {
          const prefix = `reliability-review-${String(index).padStart(4, '0')}`;
          const prospect = seedProspect(current.raw, prefix);
          const sourceCycleId = insertClosedCycle({ database: current.raw, prefix: `${prefix}-closed`, prospect });
          const majority = options.majority ?? 'system_error';
          const kind = index < 205 ? majority : majority === 'system_error' ? 'unmatched_communication' : 'system_error';
          if (kind === 'system_error') {
            insertOpenCycleWithAction({ database: current.raw, prefix: `${prefix}-active`, prospect });
            insertSourceEvent({ database: current.raw, id: `${prefix}-inbound`, personId: prospect.personId, channel: 'inbound_demo' });
          }
          const email = `${prefix}@fixture.invalid`;
          const result = services.lifecycle.reactivateFromInboundResponse({
            evidence: kind === 'system_error'
              ? { kind: 'source_event', sourceEventId: `${prefix}-inbound`, channel: 'inbound_demo' }
              : { kind: 'unknown_handle', handleKind: 'email', normalizedValue: email },
            personId: prospect.personId, prospectId: prospect.prospectId, sourceCycleId,
            newCycleId: `${prefix}-reactivated`,
            activatedAt: index < 205 || options.tied ? '2026-08-31T15:00:00.000Z' : '2026-08-31T16:00:00.000Z',
            cadence: { definitionId: cadence.id, family: 'cadence_c', version: cadence.version, contentHash: cadence.contentHash },
          });
          assert.equal(result.kind, 'review_required');
          if (result.kind !== 'review_required') throw new Error('Fixture lifecycle did not retain a review');
          assert.equal(result.reviewItem.reason, kind === 'system_error' ? 'operational_cycle_exists' : 'unknown_inbound_handle');
          const activationKey = kind === 'system_error' ? `inbound:${prefix}-inbound` : `inbound-handle:email:${email}`;
          assert.equal(result.reviewItem.activationKey, activationKey);
          expected.push({ reviewId: result.reviewItem.id, activationKey, kind, personId: prospect.personId,
            prospectId: prospect.prospectId, sourceCycleId, newCycleId: `${prefix}-reactivated` });
        }
        for (const owner of expected) seededReviews.set(owner.reviewId, owner);
        return frozenCopy(expected);
      },
      seedPromoteEvidence(reviewId: string) {
        const current = requireOpen();
        const owner = seededReviews.get(reviewId);
        assert.ok(owner && owner.kind === 'unmatched_communication', 'Only an owned unmatched review may receive fixture evidence');
        assert.equal(reviewOwners().find(row => row.reviewId === reviewId)?.status, 'open');
        const sourceEventId = `${owner.newCycleId}-matched-source`;
        insertSourceEvent({ database: current.raw, id: sourceEventId, personId: owner.personId, channel: 'inbound_demo' });
        return Object.freeze({ sourceEventId });
      },
      async importLeads(api: Pick<CallieApi, 'imports'>) {
        assert.equal(importedOwners().length, 0, 'Import scenario must use a separate empty fixture');
        assert.equal(reviewOwners().length, 0, 'Do not mix review and Leads populations');
        const people = Array.from({ length: 208 }, (_, index) => ({
          name: `Reliability Lead ${String(index).padStart(4, '0')}`,
          email: `rel-lead-${String(index).padStart(4, '0')}@fixture.invalid`,
        }));
        const preview = await api.imports.preview({ kind: 'csv', sourceName: 'reliability-208.csv',
          content: ['Name,Email,Organization', ...people.map(person => `${person.name},${person.email},Fictional Shared Organization`)].join('\n') + '\n' });
        assert.equal(preview.rowCount, 208); assert.equal(preview.validCount, 208);
        assert.deepEqual(preview.errors, []); assert.deepEqual(preview.duplicateCandidates, []);
        const receipt = await api.imports.commit({ previewId: preview.previewId, contentHash: preview.contentHash,
          mapping: { Name: 'person_name', Email: 'email', Organization: 'organization' },
          source: { channel: 'registry', referredByPersonId: null }, duplicateDecisions: [] });
        assert.equal(receipt.importedRowCount, 208);
        const stored = importedOwners();
        for (const owner of stored) importedPersonIds.add(owner.personId);
        assert.equal(stored.length, 208);
        assert.deepEqual(stored.map(({ name, email }) => ({ name, email })), people);
        assert.equal(new Set(stored.map(owner => owner.personId)).size, 208);
        assert.equal(new Set(stored.map(owner => owner.salesCycleId)).size, 208);
        assert.deepEqual([...receipt.importedPersonIds].sort(), stored.map(owner => owner.personId).sort());
        for (const owner of stored) {
          assert.equal(owner.stage, 'unreviewed'); assert.equal(owner.workflowStatus, 'active');
          assert.equal(owner.sourceChannel, 'registry'); assert.ok(owner.actionId);
        }
        return frozenCopy({ owners: stored, receipt });
      },
    };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Fixture construction and cleanup failed', { cause: error });
    }
    throw error;
  }
}

export type ReliabilityDomainFixture = Awaited<ReturnType<typeof createReliabilityDomainFixture>>;
