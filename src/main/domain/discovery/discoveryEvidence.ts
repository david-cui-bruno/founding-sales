import { createHash } from 'node:crypto';
import type { AppDatabase } from '../../db/database';
import type { SalesCyclesTable } from '../../db/domainSchema';
import type { DomainServices } from '../createDomainServices';
import { collectReceiptEvidenceViolations, type ReactivationReceiptEvidence } from '../lifecycle/reactivationEvidenceValidator';
import { reactivationCommandEnvelopeSchema, reactivationResultEnvelopeSchema } from '../lifecycle/reactivationContracts';
import { parseCanonicalJson } from '../lifecycle/lifecycleValidation';
import { parseTranscriptUtterances } from '../conversations/conversationsDomain';
import type { Property } from '../identity/identityTypes';
import { canonicalRuleJson } from '../prioritization/builtinPrioritizationRules';
import { parseCanonicalUtcMillis, parseMaintenanceProfileV1 } from '../prioritization/qualificationEngine';
import type { MaintenanceProfileV1, PropertyFact, TriggerEvent } from '../prioritization/prioritizationTypes';
import type { SourceEvent } from '../source/sourceTypes';
import { validateCloudSourceEvent, type CloudSourceEvent } from '../../../shared/contracts/cloudSourceEventContract';
import { discoveryClaimSchema, type DiscoveryClaim, type DiscoveryEvidenceRef } from '../../../shared/contracts/discoveryContract';
import type { DiscoveryEvidenceSnapshot } from './discoveryTypes';

export type DiscoveryEvidenceServices = Pick<DomainServices, 'identities' | 'sourceRepository' | 'events' |
  'outboundPermission' | 'prioritizationRepository' | 'prioritization' | 'workspaceSettings'>;

/** Operational diagnostics are retryable research work, never identity judgments. */
export class DiscoveryEvidenceDiagnosticError extends Error {
  readonly retryable = true;
  readonly disposition = 'research';
  constructor(readonly code: 'evidence_too_large' | 'invalid_evidence' | 'transaction_required' | 'stale_evidence') {
    super(`Discovery evidence: ${code}`);
    this.name = 'DiscoveryEvidenceDiagnosticError';
  }
}

type CollectionInput = { database: AppDatabase; services: DiscoveryEvidenceServices; prospectId: string; asOf: string };
type Row = Record<string, unknown>;
type Utterance = { id: string; transcript_id: string; activity_id: string; person_id: string;
  speaker: string; text: string; occurred_at: string; prospect_id: string | null; sequence: number;
  raw_text: string; transcript_storage_ref: string | null; consent_policy_record_id: string | null };
const admissions = new WeakMap<DiscoveryEvidenceSnapshot, CollectionInput>();
const dependencyKeys = ['identities', 'sourceRepository', 'events', 'outboundPermission',
  'prioritizationRepository', 'prioritization', 'workspaceSettings'] as const satisfies readonly (keyof DiscoveryEvidenceServices)[];
const normalized = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const json = canonicalRuleJson;
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
const MAX_BYTES = 1024 * 1024;
function bound(value: unknown): string {
  const bytes = json(value);
  if (Buffer.byteLength(bytes, 'utf8') > MAX_BYTES) throw new DiscoveryEvidenceDiagnosticError('evidence_too_large');
  return bytes;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Recollection closes the stale/forged-snapshot gap without parsing presentation labels. */
export function revalidateDiscoverySnapshot(snapshot: DiscoveryEvidenceSnapshot, database: AppDatabase,
  services: DiscoveryEvidenceServices): void {
  const input = admissions.get(snapshot);
  if (!input || input.database !== database || dependencyKeys.some(key => input.services[key] !== services[key])
    || collectDiscoveryEvidence(input).inputFingerprint !== snapshot.inputFingerprint) {
    throw new DiscoveryEvidenceDiagnosticError('stale_evidence');
  }
}

/** SELECT-only. The caller owns the coherent read or write transaction. */
export function collectDiscoveryEvidence(input: CollectionInput): DiscoveryEvidenceSnapshot {
  const { database, services, prospectId, asOf } = input;
  if (!database.raw.inTransaction) throw new DiscoveryEvidenceDiagnosticError('transaction_required');
  parseCanonicalUtcMillis(asOf, 'Discovery asOf');
  const identity = services.prioritizationRepository.loadQualificationInputs(prospectId);
  const person = services.identities.getPerson(identity.personId);
  const prospect = services.identities.getCanonicalProspect(identity.personId);
  if (!person || !prospect || prospect.id !== prospectId) throw new DiscoveryEvidenceDiagnosticError('invalid_evidence');
  const all = (sql: string, id = person.id): Row[] => database.raw.prepare(sql).all(id) as Row[];
  const cycles = all('SELECT * FROM sales_cycles WHERE person_id = ? ORDER BY created_at DESC, id DESC');
  const current = cycles.find(c => c.workflow_status !== 'closed' && c.workflow_status !== 'merged') ?? cycles[0];
  if (!current || current.prospect_id !== prospectId) throw new DiscoveryEvidenceDiagnosticError('invalid_evidence');
  const cycle = current as unknown as Omit<SalesCyclesTable, 'version'> & { version: number };
  const properties = services.identities.listPropertiesForProspect(prospectId);
  const organizations = services.identities.listOrganizationsForProspect(prospectId);
  const contacts = services.identities.listContactMethodsForPerson(person.id);
  const permission = services.outboundPermission.inspectPerson(person.id);
  const rawSources = database.raw.prepare('SELECT * FROM source_events WHERE person_id = ? OR prospect_id = ? ORDER BY observed_at, id').all(person.id, prospectId) as Row[];
  const cloudLinks = database.raw.prepare(`SELECT * FROM cloud_entity_links WHERE person_id = ?
    OR cloud_entity_id IN (SELECT json_extract(source_record_json, '$.sourceRecord.cloudSourceEvent.entity.cloud_entity_id')
      FROM source_events WHERE (person_id = ? OR prospect_id = ?) AND json_valid(source_record_json))
    ORDER BY cloud_entity_id`).all(person.id, person.id, prospectId) as Row[];
  const activities = all('SELECT * FROM activities WHERE person_id = ? ORDER BY occurred_at, id');
  const amendments = all('SELECT m.* FROM activity_amendments m JOIN activities a ON a.id = m.activity_id WHERE a.person_id = ? ORDER BY m.id');
  const transcripts = all('SELECT * FROM transcripts WHERE person_id = ? ORDER BY id');
  const utterances = all(`SELECT u.*, t.activity_id, t.person_id, t.raw_text, a.occurred_at, a.prospect_id, a.transcript_storage_ref, a.consent_policy_record_id
    FROM transcript_utterances u JOIN transcripts t ON t.id = u.transcript_id
    JOIN activities a ON a.id = t.activity_id AND a.person_id = t.person_id
    WHERE t.person_id = ? ORDER BY t.id, u.sequence, u.id`) as unknown as Utterance[];
  const consents = all('SELECT * FROM consent_policy_records WHERE person_id = ? ORDER BY id');
  const rawTriggers = all('SELECT * FROM trigger_events WHERE prospect_id = ? ORDER BY id', prospectId);
  const rule = services.prioritizationRepository.getActiveRuleVersion();
  if (!rule) throw new DiscoveryEvidenceDiagnosticError('invalid_evidence');
  const raw = { person, prospect, cycles, properties, organizations, contacts, permission, rawSources, cloudLinks, activities, amendments, transcripts, utterances, consents, rawTriggers,
    propertyLinks: all('SELECT * FROM prospect_properties WHERE prospect_id = ? ORDER BY property_id', prospectId),
    organizationLinks: all('SELECT * FROM prospect_organizations WHERE prospect_id = ? ORDER BY organization_id', prospectId),
    organizationAliases: all(`SELECT a.* FROM organization_aliases a JOIN prospect_organizations l ON l.organization_id = a.organization_id WHERE l.prospect_id = ? ORDER BY a.id`, prospectId),
    intakeReceipts: all('SELECT * FROM source_intake_receipts WHERE person_id = ? ORDER BY source_event_id'),
    reactivationReceipts: all('SELECT * FROM cycle_reactivation_receipts WHERE person_id = ? ORDER BY activation_key'),
    reactivationRules: all('SELECT r.* FROM reactivation_rules r JOIN sales_cycles c ON c.id = r.sales_cycle_id WHERE c.person_id = ? ORDER BY r.id'),
    stageEvents: all('SELECT e.* FROM stage_events e JOIN sales_cycles c ON c.id = e.sales_cycle_id WHERE c.person_id = ? ORDER BY e.id'),
    nextActions: all('SELECT a.* FROM next_actions a JOIN sales_cycles c ON c.id = a.sales_cycle_id WHERE c.person_id = ? ORDER BY a.id'),
    enrollments: all('SELECT e.* FROM cadence_enrollments e JOIN sales_cycles c ON c.id = e.sales_cycle_id WHERE c.person_id = ? ORDER BY e.id'),
    cadenceDefinitions: all('SELECT DISTINCT d.* FROM cadence_definitions d JOIN cadence_enrollments e ON e.cadence_definition_id = d.id JOIN sales_cycles c ON c.id = e.sales_cycle_id WHERE c.person_id = ? ORDER BY d.id'),
    ruleId: rule.id };
  const rawJson = bound(raw); // Never drop contradictory rows to fit a display budget.
  const validatedClaims: DiscoveryClaim[] = [];
  const presentation: DiscoveryClaim[] = [];
  const conflicts: Array<{ kind: 'identity' | 'ownership' | 'property'; claimIds: string[] }> = [];
  const propertySources = new Map<string, Array<{ source: SourceEvent; event: CloudSourceEvent; doorClaim: DiscoveryClaim | null }>>();
  const validSources = new Map<string, { source: SourceEvent; event: CloudSourceEvent }>();
  const addClaim = (claim: DiscoveryClaim) => {
    // Oversize individual evidence is also retryable, never silently shortened.
    if (!discoveryClaimSchema.safeParse(claim).success) throw new DiscoveryEvidenceDiagnosticError('invalid_evidence');
    (claim.certainty === 'fact' ? validatedClaims : presentation).push(claim);
    return claim;
  };
  function sourceClaim(source: SourceEvent, field: string, label: string, value: DiscoveryClaim['value'], certainty: DiscoveryClaim['certainty'] = 'fact') {
    return addClaim({ id: hash([source.id, field, label, value]), label, value, certainty,
      refs: [{ kind: 'source', sourceEventId: source.id, field, observedAt: source.observedAt }] });
  }
  for (const row of rawSources) {
    let source: SourceEvent | null;
    try { source = services.sourceRepository.getById(String(row.id)); }
    catch { throw new DiscoveryEvidenceDiagnosticError('invalid_evidence'); }
    if (!source) throw new DiscoveryEvidenceDiagnosticError('invalid_evidence');
    if (source.personId !== person.id || (source.prospectId !== null && source.prospectId !== prospectId)) {
      conflicts.push({ kind: 'ownership', claimIds: [] }); continue;
    }
    if (source.observedAt > asOf) continue;
    const parsed = validateCloudSourceEvent(source.sourceRecord.cloudSourceEvent);
    if (!parsed.success) {
      addClaim({ id: hash([source.id, 'unsupported']), label: 'Source requires additional research', value: null, certainty: 'unknown', refs: [] });
      continue;
    }
    const event = parsed.data;
    if (event.channel !== source.channel || new Date(event.observed_at).toISOString() !== source.observedAt) {
      throw new DiscoveryEvidenceDiagnosticError('invalid_evidence');
    }
    if (cloudLinks.some(link => link.cloud_entity_id === event.entity.cloud_entity_id && link.person_id !== person.id)) {
      conflicts.push({ kind: 'ownership', claimIds: [] }); continue;
    }
    const descriptor = event.entity.person;
    if (!descriptor) continue;
    const names = [descriptor.full_name, ...descriptor.org_names].filter((v): v is string => v !== null && v.trim().length > 0);
    const knownNames = [person.displayName, ...person.aliases];
    if (!names.some(name => knownNames.some(known => normalized(name) === normalized(known)))) {
      conflicts.push({ kind: 'identity', claimIds: [] }); continue;
    }
    // The source must name this identity AND describe an already-linked exact property.
    const address = event.entity.property?.situs_address;
    if (!address) continue;
    const sourceParcelId = event.entity.property!.parcel_id;
    const parcelMatches = sourceParcelId === null ? [] : properties.filter(p =>
      (p.sourceRecord as { parcelId?: unknown } | null)?.parcelId === sourceParcelId);
    if (parcelMatches.length > 1) {
      const claim = sourceClaim(source, 'entity.property.parcel_id', 'Ambiguous linked parcel identifier', sourceParcelId);
      conflicts.push({ kind: 'ownership', claimIds: [claim.id] }); continue;
    }
    if (parcelMatches.length === 1) {
      const property = parcelMatches[0]!;
      // Resolve only this Person's existing links. Never hide a known-parcel
      // contradiction behind another property's otherwise scoreable evidence.
      const fields = [
        ['line1', property.addressLine1, address.line1], ['locality', property.locality, address.locality],
        ['region', property.region, address.region], ['country_code', property.countryCode, address.country_code],
        ['postal_code', property.postalCode, address.postal_code],
      ] as const;
      const disagreements = fields.filter(([, stored, observed]) => stored !== null && observed !== null
        && normalized(stored) !== normalized(observed));
      if (disagreements.length) {
        const claimIds = [sourceClaim(source, 'entity.property.parcel_id', 'Linked parcel identifier', sourceParcelId).id];
        for (const [field, stored, observed] of disagreements) {
          claimIds.push(sourceClaim(source, `entity.property.situs_address.${field}`, `Conflicting property ${field}`, observed).id);
          // Canonical rows have no independent citation carrier. Preserve their
          // values as unresolved context, not as facts falsely citing this source.
          claimIds.push(addClaim({ id: hash([source.id, property.id, field, stored]),
            label: `Stored property ${property.id} ${field} requires reconciliation`, value: stored,
            certainty: 'unknown', refs: [] }).id);
        }
        conflicts.push({ kind: 'property', claimIds }); continue;
      }
    }
    if (!address.locality || !address.region) continue;
    const matches = properties.filter(p => p.addressLine2 === null && normalized(p.addressLine1) === normalized(address.line1)
      && normalized(p.locality) === normalized(address.locality!) && normalized(p.region) === normalized(address.region!)
      && p.countryCode.toUpperCase() === address.country_code.toUpperCase()
      && (p.postalCode === null || address.postal_code === null || normalized(p.postalCode) === normalized(address.postal_code)));
    if (matches.length !== 1) {
      if (matches.length > 1) conflicts.push({ kind: 'ownership', claimIds: [] });
      continue;
    }
    const property = matches[0]!;
    const parcelId = (property.sourceRecord as { parcelId?: unknown } | null)?.parcelId;
    if (parcelId != null && event.entity.property?.parcel_id != null && parcelId !== event.entity.property.parcel_id) {
      conflicts.push({ kind: 'ownership', claimIds: [] }); continue;
    }
    validSources.set(source.id, { source, event });
    sourceClaim(source, 'observed_at', 'Source observed', event.observed_at);
    if (descriptor.full_name) sourceClaim(source, 'entity.person.full_name', 'Named property owner', descriptor.full_name);
    for (const name of descriptor.org_names) {
      if (organizations.some(org => normalized(org.canonicalName) === normalized(name))) sourceClaim(source, 'entity.person.org_names', 'Linked owner entity', name);
    }
    const count = event.entity.property!.unit_count;
    const doorClaim = count === null ? null : sourceClaim(source, 'entity.property.unit_count', 'Door count', count);
    sourceClaim(source, 'entity.property.situs_address.line1', 'Property address', address.line1);
    sourceClaim(source, 'entity.property.situs_address.locality', 'Property locality', address.locality);
    sourceClaim(source, 'entity.property.situs_address.region', 'Property region', address.region);
    sourceClaim(source, 'entity.property.situs_address.country_code', 'Property country', address.country_code);
    const entries = propertySources.get(property.id) ?? [];
    entries.push({ source, event, doorClaim }); propertySources.set(property.id, entries);
    if (event.signal_flags.self_managed !== null) sourceClaim(source, 'signal_flags.self_managed', 'Self-managed', event.signal_flags.self_managed, 'inference');
    if (event.channel === 'frbo') {
      sourceClaim(source, 'payload.listing_url', 'Listing URL', event.payload.listing_url as string);
      if (event.payload.listed_at !== null) sourceClaim(source, 'payload.listed_at', 'Listing dated', event.payload.listed_at as string);
      if (event.signal_flags.vacancy !== null) sourceClaim(source, 'signal_flags.vacancy', 'Reported vacancy', event.signal_flags.vacancy);
    }
    if (event.channel === 'violation') {
      sourceClaim(source, 'payload.opened_at', 'Violation opened date, not a deadline', event.payload.opened_at as string | null);
      sourceClaim(source, 'payload.status', 'Violation status', event.payload.status as string);
    }
  }
  const amendedIds = new Set(amendments.map(a => a.activity_id));
  for (const row of activities) {
    if (amendedIds.has(row.id) || String(row.occurred_at) > asOf) continue;
    const activity = services.events.getActivity(String(row.id));
    if (!activity || activity.personId !== person.id || (activity.prospectId !== null && activity.prospectId !== prospectId)) continue;
    if (activity.callOutcome !== null) addClaim({ id: hash([activity.id, 'call_outcome']), label: 'Call outcome', value: activity.callOutcome,
      certainty: 'fact', refs: [{ kind: 'activity', activityId: activity.id, field: 'call_outcome', observedAt: activity.occurredAt }] });
    // Arbitrary activity metadata and notes are not property/buyer-intent assertions.
  }

  const usableUtterances = utterances.filter(u => u.speaker === 'lead' && u.person_id === person.id
    && (u.prospect_id === null || u.prospect_id === prospectId) && u.occurred_at <= asOf && !amendedIds.has(u.activity_id)
    && u.transcript_storage_ref === `db:transcripts/${u.transcript_id}`
    && consents.some(c => c.id === u.consent_policy_record_id && c.activity_id === u.activity_id && c.person_id === person.id && c.decision === 'granted')
    && parseTranscriptUtterances(u.raw_text)[u.sequence]?.text === u.text
    && parseTranscriptUtterances(u.raw_text)[u.sequence]?.speaker === u.speaker);
  for (const u of usableUtterances) addClaim({ id: hash([u.id, 'quote']), label: 'Lead statement', value: u.text, certainty: 'fact', refs: [utteranceRef(u)] });
  const admittedProperties: PropertyFact[] = [];
  for (const property of properties) {
    const supports = propertySources.get(property.id);
    if (!supports) continue;
    const counts = supports.map(s => s.event.entity.property!.unit_count).filter((n): n is number => n !== null);
    const countConflict = new Set(counts).size > 1 || (property.doorCount !== null && counts.some(n => n !== property.doorCount));
    if (countConflict) conflicts.push({ kind: 'property', claimIds: supports.flatMap(s => s.doorClaim ? [s.doorClaim.id] : []) });
    const maintenanceProfile = admitProfile(property, properties, usableUtterances, addClaim, conflicts);
    admittedProperties.push({ id: property.id, doorCount: countConflict ? null : counts[0] ?? null,
      countryCode: property.countryCode, region: property.region, locality: property.locality,
      verifiedAt: property.verifiedAt !== null && property.verifiedAt <= asOf ? property.verifiedAt : null, maintenanceProfile });
  }
  const triggers: TriggerEvent[] = [];
  for (const { source, event } of validSources.values()) {
    if (event.channel !== 'frbo' || event.trigger?.type !== 'frbo_listing' || event.signal_flags.vacancy !== true
      || (typeof event.payload.listed_at === 'string' && new Date(event.payload.listed_at).toISOString() > source.observedAt)) continue;
    const existing = services.prioritizationRepository.getTriggerEventBySourceEvent(source.id);
    if (existing) {
      if (existing.prospectId === prospectId && existing.triggerType === 'live_vacancy' && existing.effectiveAt === source.observedAt
        && existing.evidence.proof.kind === 'source_event' && existing.evidence.proof.sourceEventId === source.id
        && existing.evidence.proof.sourceObservedAt === source.observedAt && existing.evidence.function === 'decaying'
        && existing.evidence.evidenceRefs.length > 0 && existing.evidence.evidenceRefs.every(ref => ref === event.payload.listing_url)
        && services.prioritizationRepository.getRuleVersion(existing.evidence.authoredUnderRuleVersionId) !== null) triggers.push(existing);
      continue; // One source permits one trigger, even when its old trigger is not admissible.
    }
    triggers.push({ id: `discovery:${hash([source.id, 'live_vacancy'])}`, prospectId, sourceEventId: source.id,
      reactivationReceiptActivationKey: null, reactivationRuleId: null, triggerType: 'live_vacancy',
      effectiveAt: source.observedAt, expiresAt: null, strengthMultiplier: 1, verificationState: 'unverified', createdAt: source.observedAt,
      evidence: { formatVersion: 1, triggerType: 'live_vacancy', authoredUnderRuleVersionId: rule.id, function: 'decaying',
        evidenceRefs: [event.payload.listing_url as string], proof: { kind: 'source_event', sourceEventId: source.id, sourceObservedAt: source.observedAt } } });
  }
  for (const row of rawTriggers) {
    if (row.trigger_type !== 'nurture_resurrection') continue;
    const trigger = services.prioritizationRepository.getTriggerEventById(String(row.id));
    if (trigger && admitsReceiptTrigger(database, trigger, person.id, prospectId, cycle.id, raw.reactivationReceipts)
      && services.prioritizationRepository.getRuleVersion(trigger.evidence.authoredUnderRuleVersionId) !== null) triggers.push(trigger);
  }
  const original = services.sourceRepository.getById(prospect.originalSourceEventId);
  if (!original || original.personId !== person.id || (original.prospectId !== null && original.prospectId !== prospectId)) throw new DiscoveryEvidenceDiagnosticError('invalid_evidence');
  const conversations = activities.filter(a => !amendedIds.has(a.id) && String(a.occurred_at) <= asOf
    && (a.prospect_id === null || a.prospect_id === prospectId)
    && (a.kind === 'interview' || (a.kind === 'call' && (a.observed_outcome === 'spoke' || a.call_outcome === 'spoke'))));
  const conflictIds = new Set(conflicts.flatMap(c => c.claimIds));
  const allClaims = [...validatedClaims, ...presentation];
  const completeClaims = [...allClaims.filter(c => conflictIds.has(c.id)), ...allClaims.filter(c => !conflictIds.has(c.id))];
  const snapshot: DiscoveryEvidenceSnapshot = {
    personId: person.id, prospectId, salesCycleId: cycle.id, personName: person.displayName,
    personVersion: person.version, prospectVersion: prospect.version, cycleVersion: cycle.version,
    stage: cycle.stage, workflowStatus: cycle.workflow_status, qualificationState: prospect.qualificationState,
    qualificationGateReason: prospect.qualificationGateReason, operationallyBlocked: person.deletedAt !== null || person.optedOut || permission.kind === 'blocked',
    unresolvedIdentity: validSources.size === 0, identitySupported: validSources.size > 0, resurfaceAt: cycle.resurface_at,
    originalSource: { id: original.id, channel: original.channel, observedAt: original.observedAt, evidenceRef: validSources.has(original.id) ? original.evidenceRef : null },
    properties: admittedProperties, contacts: contacts.map(c => ({ id: c.id, kind: c.kind, validationState: c.validationState, reachability: c.reachability })),
    triggers: triggers.sort((a, b) => a.id.localeCompare(b.id)), validatedClaims, claims: completeClaims.slice(0, 100), conflicts,
    lastConversationAt: conversations.length ? String(conversations[conversations.length - 1]!.occurred_at) : null,
    conversationActivityIds: conversations.map(a => String(a.id)), inputFingerprint: createHash('sha256').update(rawJson).digest('hex'), ruleVersionId: rule.id,
  };
  bound({ raw, snapshot });
  // Capture bindings, not a mutable caller-owned container or the full service graph.
  const { identities, sourceRepository, events, outboundPermission, prioritizationRepository, prioritization, workspaceSettings } = services;
  freeze(snapshot); admissions.set(snapshot, { ...input,
    services: { identities, sourceRepository, events, outboundPermission, prioritizationRepository, prioritization, workspaceSettings } });
  return snapshot;
}

function utteranceRef(u: Utterance): DiscoveryEvidenceRef {
  return { kind: 'utterance', activityId: u.activity_id, transcriptId: u.transcript_id, utteranceId: u.id, quote: u.text, observedAt: u.occurred_at };
}

/** Deliberately narrow explicit statements, not sentiment, keywords, or model labels. */
function admitProfile(property: Property, linkedProperties: Property[], utterances: Utterance[], add: (c: DiscoveryClaim) => DiscoveryClaim,
  conflicts: Array<{ kind: 'identity' | 'ownership' | 'property'; claimIds: string[] }>): MaintenanceProfileV1 | null {
  // Street-only sentences cannot distinguish cities, units, or duplicate linked rows.
  // Include unsupported linked properties too. A profile's refs cannot resolve ambiguity.
  if (linkedProperties.filter(p => normalized(p.addressLine1) === normalized(property.addressLine1)).length !== 1) return null;
  let profile: MaintenanceProfileV1 | null;
  try { profile = parseMaintenanceProfileV1(property.maintenanceProfile); } catch { profile = null; }
  const supported: Array<{ management: 'self_managed' | 'third_party'; claim: DiscoveryClaim; id: string }> = [];
  for (const u of utterances) {
    // Address-specific complete sentences avoid attributing a portfolio statement to the first property.
    const management = u.text === `I self-manage ${property.addressLine1}.` ? 'self_managed'
      : u.text === `A third-party manager manages ${property.addressLine1}.` ? 'third_party' : null;
    if (!management) continue;
    const claim = add({ id: hash([u.id, property.id, 'management']), label: `Management at ${property.addressLine1}`,
      value: management, certainty: 'fact', refs: [utteranceRef(u)] });
    supported.push({ management, claim, id: u.id });
  }
  if (new Set(supported.map(s => s.management)).size > 1 || supported.some(s => profile !== null && profile.management !== 'unknown' && s.management !== profile.management)) {
    conflicts.push({ kind: 'property', claimIds: supported.map(s => s.claim.id) }); return null;
  }
  const refs = supported.filter(s => profile !== null && profile.evidenceRefs.includes(s.id) && profile.management === s.management);
  if (!refs.length) return null;
  return { formatVersion: 1, management: refs[0]!.management, relevantProfile: 'unknown', evidenceRefs: refs.map(s => s.id).sort() };
}

/** Exact semantic/value and complete reference comparison against full admitted evidence. */
export function validateDiscoveryClaim({ snapshot, claim }: { snapshot: DiscoveryEvidenceSnapshot; claim: DiscoveryClaim }): boolean {
  if (!admissions.has(snapshot) || !discoveryClaimSchema.safeParse(claim).success || claim.refs.length === 0 || claim.certainty !== 'fact') return false;
  return snapshot.validatedClaims.some(valid => valid.label === claim.label && valid.value === claim.value && valid.certainty === claim.certainty
    && claim.refs.every(ref => valid.refs.some(known => json(known) === json(ref))));
}

/** Resolve the real immutable receipt, consumed rule, initial stage/action and cadence evidence. */
function admitsReceiptTrigger(database: AppDatabase, trigger: TriggerEvent, personId: string,
  prospectId: string, cycleId: string, rows: Row[]): boolean {
  const { evidence } = trigger;
  const proof = evidence.proof;
  if (proof.kind !== 'reactivation_rule_receipt' || evidence.function !== 'windowed'
    || trigger.prospectId !== prospectId || trigger.sourceEventId !== null
    || trigger.reactivationReceiptActivationKey !== proof.activationKey || trigger.reactivationRuleId !== proof.ruleId
    || proof.newCycleId !== cycleId || trigger.effectiveAt !== proof.activatedAt || evidence.startsAt !== proof.activatedAt
    || evidence.evidenceRefs.length === 0 || !evidence.evidenceRefs.every(ref => ref === proof.activationKey)) return false;
  const row = rows.find(r => r.activation_key === proof.activationKey);
  if (!row || row.activation_kind !== 'rule' || row.person_id !== personId
    || row.source_cycle_id !== proof.sourceCycleId || row.new_cycle_id !== proof.newCycleId
    || row.reactivation_rule_id !== proof.ruleId || row.created_at !== proof.activatedAt) return false;
  try {
    if (parseCanonicalUtcMillis(evidence.endsAt, 'endsAt') !== parseCanonicalUtcMillis(proof.activatedAt, 'activatedAt') + 14 * 86400000) return false;
    const receipt: ReactivationReceiptEvidence = {
      activationKey: String(row.activation_key), activationKind: 'rule', personId: String(row.person_id),
      sourceCycleId: String(row.source_cycle_id), reactivationRuleId: String(row.reactivation_rule_id),
      sourceEventId: row.source_event_id === null ? null : String(row.source_event_id), newCycleId: String(row.new_cycle_id),
      createdAt: String(row.created_at), command: parseCanonicalJson(String(row.command_json), reactivationCommandEnvelopeSchema),
      result: parseCanonicalJson(String(row.result_json), reactivationResultEnvelopeSchema),
    };
    const command = receipt.command.command;
    return 'ruleType' in command && command.ruleType === proof.ruleType && command.ruleId === proof.ruleId
      && command.personId === personId && command.prospectId === prospectId && command.sourceCycleId === proof.sourceCycleId
      && command.newCycleId === cycleId && command.activatedAt === proof.activatedAt
      && collectReceiptEvidenceViolations(database, receipt).length === 0;
  } catch { return false; }
}
