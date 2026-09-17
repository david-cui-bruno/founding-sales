import { QueryCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { researchReviewedCapabilitySchema, researchSetupWriteRequestSchema, researchSetupStatusRequestSchema, researchSetupRemoteStatusSchema, researchSetupReceiptSchema, type ResearchSetupBlocker, type ResearchSetupReceipt } from '../../../../src/shared/contracts/researchSetupContract';
import { ownerResearchSourceKey, ownerResearchSourceSchema, type OwnerResearchSource } from '../../../../src/shared/contracts/ownerCommandContract';
import { effectiveDiscoveryProvider, type DiscoveryProvider } from '../../../../src/main/research/companyResearchTypes';
import { DynamoStore, fingerprint, keyPart, type Stored } from './dynamoStore';
import { budgetKey, budgetSchema, planDiscoveryBudget, researchAdmissionKey } from './discoveryReservationStore';
import { planResearchBudget } from './workerAccountRepository';
import { WorkerAuth } from './workerAuth';

export const guidedResearchMarkerKey = 'GUIDED_RESEARCH_SETUP';
export const guidedResearchBudgetId = 'guided-research-v1';
export const placesResearchBudgetId = 'places-territory-v1';
/** The discovery ledger a provider draws on, derived from the provider alone: replacing with the same provider reuses its ledger and its spent balance. */
const researchBudgetIdFor = (provider: DiscoveryProvider): string => provider === 'places' ? placesResearchBudgetId : guidedResearchBudgetId;
export type ResearchSetupProfile = { reviewedCapability?: unknown; credentialParameterDeclared?: boolean; placesCredentialParameterDeclared?: boolean };
const markerSchema = z.strictObject({ version: z.literal(1), descriptorFingerprint: z.string().regex(/^[a-f0-9]{64}$/), settingsFingerprint: z.string().regex(/^[a-f0-9]{64}$/), workspaceId: z.string(), pairingId: z.uuid(), budgetId: z.enum([guidedResearchBudgetId, placesResearchBudgetId]) });
const receiptKey = (id: string) => `RESEARCH_SETUP_REQUEST#${keyPart(id)}`;
/** The discovery ledger the stored configuration draws on; the guided ledger when there is none yet. */
function activeResearchBudgetId(source: Stored<unknown> | null): string {
  const parsed = source ? ownerResearchSourceSchema.safeParse(source.data) : null;
  return parsed?.success && parsed.data.research ? parsed.data.research.budgetId : guidedResearchBudgetId;
}
/** A cumulative ceiling only ever widens: a proposal at or below the current limit leaves the row as it is (fenced), and spent is never touched. */
function widenBudget(store: DynamoStore, key: string, row: Stored<unknown>, limitMicros: number): TransactWriteItem {
  const budget = budgetSchema.parse(row.data);
  if (budget.spent > budget.limit) throw Error('research_setup_budget_corrupt');
  if (limitMicros <= budget.limit) return store.check(key, row.rev, { limit: budget.limit, spent: budget.spent });
  return store.put(key, { ...budget, limit: limitMicros }, row.rev, { limit: limitMicros, spent: budget.spent }, { limit: budget.limit, spent: budget.spent });
}
/** Readiness for one discovery provider. The cited provider needs its model credential parameter; Places needs the reviewed cost per
 *  call and its own credential parameter instead. The descriptor checks are shared. */
export function reviewedResearchProfile(profile: ResearchSetupProfile, now: string, provider: DiscoveryProvider = 'responses_cited') {
  const blockers: ResearchSetupBlocker[] = [];
  let raw = profile.reviewedCapability;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = false; } }
  const parsed = researchReviewedCapabilitySchema.safeParse(raw);
  const descriptor = parsed.success ? parsed.data : null;
  if (raw === undefined) blockers.push('operator_descriptor_missing');
  else if (!descriptor) blockers.push('operator_descriptor_invalid');
  else if (Date.parse(descriptor.reviewedAt) > Date.parse(now) || Date.parse(descriptor.expiresAt) <= Date.parse(now)) blockers.push('operator_descriptor_expired');
  if (provider === 'places') {
    if (descriptor && descriptor.placesSearchCostMicros === undefined) blockers.push('places_cost_missing');
    if (!profile.placesCredentialParameterDeclared) blockers.push('places_credential_parameter_missing');
  } else if (!profile.credentialParameterDeclared) blockers.push('credential_parameter_missing');
  return { descriptor, descriptorFingerprint: descriptor ? fingerprint(descriptor) : null, credentialParameterDeclared: profile.credentialParameterDeclared === true,
    placesCredentialParameterDeclared: profile.placesCredentialParameterDeclared === true, blockers };
}
function checkBinding(raw: unknown, config: OwnerResearchSource) {
  const marker = markerSchema.parse(raw);
  if (marker.workspaceId !== config.workspaceId || marker.pairingId !== config.pairingId || !config.research || config.research.budgetId !== marker.budgetId || fingerprint(config.research) !== marker.settingsFingerprint) throw Error('research_setup_binding_conflict');
  return marker;
}
/** Synchronous final check after all awaited identity/revision reads. */
export function assertGuidedResearch(raw: unknown, config: OwnerResearchSource, profile: ResearchSetupProfile, now: string) {
  const marker = checkBinding(raw, config);
  const current = reviewedResearchProfile(profile, now, effectiveDiscoveryProvider(config.research?.discoveryProvider));
  if (current.blockers.length || current.descriptorFingerprint !== marker.descriptorFingerprint) throw Error('research_setup_descriptor_unavailable');
}
/** Existing execution calls this before reservations and each guarded provider start. */
export async function guardGuidedResearch(store: DynamoStore, config: OwnerResearchSource, profile: ResearchSetupProfile) {
  const row = await store.get<unknown>(guidedResearchMarkerKey);
  if (!row) {
    const admission = await store.get<unknown>(researchAdmissionKey);
    // The ID was unrestricted before guided setup. Only durable enrollment
    // distinguishes guided ownership; malformed admission evidence fails closed.
    if (admission && !z.strictObject({ version: z.literal(1), kind: z.literal('legacy') }).safeParse(admission.data).success) throw Error('research_setup_marker_missing');
    return null; // Legacy execution is intentionally unchanged.
  }
  assertGuidedResearch(row.data, config, profile, store.now());
  return row;
}

export class ResearchSetupService {
  constructor(readonly input: { auth: WorkerAuth; profile?: ResearchSetupProfile }) {}
  private async authenticated(identity: { workspaceId: string; pairingId: string }, bearer: string, write: boolean) {
    const principal = await this.input.auth.authenticate(bearer, [write ? 'commands:write' : 'events:read']);
    this.input.auth.store.workspace(identity.workspaceId);
    if (principal.kind !== 'device' || principal.pairingId !== identity.pairingId) throw Error('research_setup_identity_conflict');
    return new DynamoStore({ ...this.input.auth.options, dynamo: this.input.auth.fencedDynamo(principal) });
  }
  private async discoveryPresent(store: DynamoStore) {
    // Bounded initial legacy detection. All application admission writers CAS the
    // shared admission row, source and marker; final CAS closes this query.
    const result = await store.options.dynamo.send(new QueryCommand({ TableName: store.options.tableName, ConsistentRead: true, Limit: 1,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': store.key('').pk, ':prefix': { S: 'BUDGET#discovery#' } } }));
    return !!result.Items?.length || !!result.LastEvaluatedKey;
  }
  private async receipt(store: DynamoStore, identity: { workspaceId: string; pairingId: string; requestId: string }, fp?: string) {
    const row = await store.get<unknown>(receiptKey(identity.requestId));
    if (!row) return null;
    const receipt = researchSetupReceiptSchema.parse(row.data);
    if (receipt.workspaceId !== identity.workspaceId || receipt.pairingId !== identity.pairingId || receipt.requestId !== identity.requestId || fp && receipt.fingerprint !== fp) throw Error('command_fingerprint_conflict');
    return receipt;
  }
  async status(raw: unknown, bearer: string) {
    const request = researchSetupStatusRequestSchema.parse(raw);
    const store = await this.authenticated(request, bearer, false);
    const admission = await store.get<unknown>(researchAdmissionKey);
    const source = await store.get<unknown>(ownerResearchSourceKey());
    const marker = await store.get<unknown>(guidedResearchMarkerKey);
    const research = await store.get<unknown>('BUDGET#research');
    const activeBudgetId = activeResearchBudgetId(source);
    const discovery = await store.get<unknown>(budgetKey(activeBudgetId));
    const legacyDiscovery = !marker && await this.discoveryPresent(store);
    const receipt = request.requestId ? await this.receipt(store, { ...request, requestId: request.requestId }) : null;
    const fence = (key: string, row: Stored<unknown> | null) => row ? store.check(key, row.rev) : store.absent(key);
    const fences = [fence(researchAdmissionKey, admission), fence(ownerResearchSourceKey(), source), fence(guidedResearchMarkerKey, marker), fence('BUDGET#research', research), fence(budgetKey(activeBudgetId), discovery)];
    if (request.requestId) fences.push(receipt ? store.check(receiptKey(request.requestId), 1) : store.absent(receiptKey(request.requestId)));
    // Join the snapshot to live token/pairing revisions before sampling time.
    await store.transact(fences);
    const checkedAt = store.now();
    const profile = reviewedResearchProfile(this.input.profile ?? {}, checkedAt);
    // Places readiness is reported separately so a cited workspace is never blocked by a Places gap, and vice versa.
    const placesBlockers = reviewedResearchProfile(this.input.profile ?? {}, checkedAt, 'places').blockers;
    const blockers = [...profile.blockers];
    let selector: OwnerResearchSource | null = null;
    if (source) {
      const parsed = ownerResearchSourceSchema.safeParse(source.data);
      if (parsed.success && parsed.data.workspaceId === request.workspaceId && parsed.data.pairingId === request.pairingId) selector = parsed.data;
      else blockers.push('state_corrupt');
    }
    if (!marker && (source || research || discovery || legacyDiscovery || admission) || marker && (!source || !research || !discovery || !admission)) blockers.push('legacy_or_orphan_state');
    if (marker) {
      try {
        if (!selector) throw Error('missing_selector');
        const binding = checkBinding(marker.data, selector);
        if (binding.descriptorFingerprint !== profile.descriptorFingerprint) blockers.push('descriptor_changed');
      } catch { blockers.push('state_corrupt'); }
    }
    const ledger = (row: Stored<unknown> | null) => {
      if (!row) return null;
      const parsed = budgetSchema.safeParse(row.data);
      if (!parsed.success || parsed.data.spent > parsed.data.limit) { blockers.push('budget_corrupt'); return null; }
      return { limitMicros: parsed.data.limit, reservedOrSpentMicros: parsed.data.spent, remainingMicros: parsed.data.limit - parsed.data.spent };
    };
    const discoveryLedger = ledger(discovery); const researchLedger = ledger(research);
    return researchSetupRemoteStatusSchema.parse({ workspaceId: request.workspaceId, pairingId: request.pairingId, selector, discoveryLedger, researchLedger, ...profile, blockers: [...new Set(blockers)], checkedAt, receipt, placesBlockers });
  }
  async apply(raw: unknown, bearer: string): Promise<ResearchSetupReceipt> {
    const envelope = researchSetupWriteRequestSchema.parse(raw);
    const request = envelope.kind === 'cancel' ? envelope.originalRequest : envelope;
    const store = await this.authenticated(request, bearer, true);
    const fp = fingerprint(request);
    const replay = () => this.receipt(store, request, fp);
    const previous = await replay(); if (previous) return previous;
    const identity = { workspaceId: request.workspaceId, pairingId: request.pairingId, requestId: request.requestId, kind: request.kind, fingerprint: fp };
    let receipt: ResearchSetupReceipt;
    const writes: TransactWriteItem[] = [];
    if (envelope.kind === 'cancel') {
      receipt = { ...identity, status: 'cancelled', revision: null, state: null };
    } else if (request.kind === 'approve') {
      const provider = effectiveDiscoveryProvider(request.input.discoveryProvider);
      const profile = reviewedResearchProfile(this.input.profile ?? {}, store.now(), provider);
      if (profile.blockers.length || !profile.descriptor || profile.descriptorFingerprint !== request.input.descriptorFingerprint) throw Error('research_setup_descriptor_unavailable');
      const [source, marker, page, admission] = await Promise.all([store.get<unknown>(ownerResearchSourceKey()), store.get<unknown>(guidedResearchMarkerKey), store.get<unknown>('BUDGET#research'), store.get<unknown>(researchAdmissionKey)]);
      const proposal = request.input; const descriptor = profile.descriptor;
      // Places reserves the reviewed cost of one text-search call per batch; the cited provider reserves search plus model per run.
      const placesCost = descriptor.placesSearchCostMicros;
      if (provider === 'places' && placesCost === undefined) throw Error('research_setup_descriptor_unavailable');
      const discoveryCost = provider === 'places' && placesCost !== undefined ? placesCost : descriptor.capability.searchCostMicros + descriptor.capability.modelCostMicros;
      if (discoveryCost > proposal.discoveryCeilingMicros || descriptor.researchReservationMicros > proposal.researchCeilingMicros) throw Error('research_setup_ceiling_insufficient');
      const limits = { maxCompanies: proposal.maxCompanies, maxPages: proposal.maxPages, maxBytes: proposal.maxBytes };
      const budgetId = researchBudgetIdFor(provider);
      const settings = (previous: OwnerResearchSource['research']) => ({
        workspaceId: request.workspaceId, budgetId, audience: proposal.audience,
        audienceRevision: (previous?.audienceRevision ?? 0) + 1, sourceRevision: (previous?.sourceRevision ?? 0) + 1, budgetRevision: (previous?.budgetRevision ?? 0) + 1,
        discoveryLimits: { ...limits, maxCostMicros: discoveryCost }, researchLimits: { ...limits, maxCostMicros: descriptor.researchReservationMicros }, capability: descriptor.capability,
        maxAccountBudgetMicros: descriptor.researchReservationMicros, permittedSources: proposal.permittedSources, preparationCommandId: request.requestId,
        // Cited configurations keep no provider key so their stored bytes and fingerprints are exactly what they were.
        ...(provider === 'places' ? { discoveryProvider: 'places' as const } : {}) });
      const binding = (config: OwnerResearchSource) => store.put(guidedResearchMarkerKey, markerSchema.parse({ version: 1, workspaceId: request.workspaceId, pairingId: request.pairingId, budgetId,
        descriptorFingerprint: profile.descriptorFingerprint, settingsFingerprint: fingerprint(config.research) }), marker?.rev ?? null);
      if (proposal.expectedRevision === 0) {
        if (source || marker || page || admission || await this.discoveryPresent(store)) throw Error('research_setup_legacy_or_orphan_state');
        const config = ownerResearchSourceSchema.parse({ version: 1, workspaceId: request.workspaceId, pairingId: request.pairingId, revision: 1, state: 'active', research: settings(null) });
        writes.push(store.put(researchAdmissionKey, { version: 1, kind: 'guided' }, null), store.put(ownerResearchSourceKey(), config, null),
          planDiscoveryBudget(store, { budgetId, limitMicros: proposal.discoveryCeilingMicros }), planResearchBudget(store, proposal.researchCeilingMicros), binding(config));
        receipt = { ...identity, status: 'applied', revision: 1, state: 'active' };
      } else {
        // Replace: the worker already holds a guided setup. Spent budget and the admission fence are kept; only what it discovers next changes.
        // The stored revision must be exactly the one the owner read; anything else fails closed with no writes.
        if (!source || !marker || !page || !admission || !z.strictObject({ version: z.literal(1), kind: z.literal('guided') }).safeParse(admission.data).success) throw Error('research_setup_legacy_or_orphan_state');
        const current = ownerResearchSourceSchema.parse(source.data);
        if (current.workspaceId !== request.workspaceId || current.pairingId !== request.pairingId || current.revision !== proposal.expectedRevision) throw Error('research_setup_revision_conflict');
        checkBinding(marker.data, current);
        const config = ownerResearchSourceSchema.parse({ ...current, revision: current.revision + 1, state: 'active', research: settings(current.research) });
        const discovery = await store.get<unknown>(budgetKey(budgetId));
        writes.push(discovery ? widenBudget(store, budgetKey(budgetId), discovery, proposal.discoveryCeilingMicros) : planDiscoveryBudget(store, { budgetId, limitMicros: proposal.discoveryCeilingMicros }),
          widenBudget(store, 'BUDGET#research', page, proposal.researchCeilingMicros), store.check(researchAdmissionKey, admission.rev), store.put(ownerResearchSourceKey(), config, source.rev), binding(config));
        receipt = { ...identity, status: 'applied', revision: config.revision, state: 'active' };
      }
    } else {
      const source = await store.get<unknown>(ownerResearchSourceKey());
      const marker = await store.get<unknown>(guidedResearchMarkerKey);
      if (!source || !marker) throw Error('research_setup_legacy_or_orphan_state');
      const config = ownerResearchSourceSchema.parse(source.data);
      if (config.workspaceId !== request.workspaceId || config.pairingId !== request.pairingId || config.revision !== request.input.expectedRevision) throw Error('research_setup_revision_conflict');
      const binding = checkBinding(marker.data, config);
      if (request.input.state === 'active') {
        const profile = reviewedResearchProfile(this.input.profile ?? {}, store.now(), effectiveDiscoveryProvider(config.research?.discoveryProvider));
        if (profile.blockers.length || profile.descriptorFingerprint !== binding.descriptorFingerprint) throw Error('research_setup_descriptor_unavailable');
        for (const key of ['BUDGET#research', budgetKey(binding.budgetId)]) {
          const row = await store.get<unknown>(key); if (!row) throw Error('research_setup_budget_missing');
          const budget = budgetSchema.parse(row.data); if (budget.spent > budget.limit) throw Error('research_setup_budget_corrupt');
          writes.push(store.check(key, row.rev));
        }
      }
      const next = ownerResearchSourceSchema.parse({ ...config, revision: config.revision + 1, state: request.input.state });
      writes.push(store.put(ownerResearchSourceKey(), next, source.rev), store.check(guidedResearchMarkerKey, marker.rev));
      receipt = { ...identity, status: 'applied', revision: next.revision, state: next.state };
    }
    writes.push(store.put(receiptKey(request.requestId), researchSetupReceiptSchema.parse(receipt), null));
    try { await store.transact(writes); return receipt; }
    catch (error) { const committed = await replay(); if (committed) return committed; throw error; }
  }
}
