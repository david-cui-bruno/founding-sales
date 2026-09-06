import type { AppDatabase } from '../db/database';
import type { DomainServices } from '../domain/createDomainServices';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../domain/cadence/cadenceScheduler';
import { JurisdictionRepository } from '../domain/compliance/jurisdictionRepository';
import { evaluateOutboundAuthorization } from '../domain/compliance/outboundAuthorization';
import { selectPrimaryPhone } from '../domain/contacts/contactPresentation';
import type { ContactMethod } from '../../shared/contracts/leadDetailContract';
import type { OutboundAuthorizationReasonCode } from '../../shared/contracts/commonContract';
import {
  assertTriageArtifactSafe, leadTriageSnapshotRequestSchema, leadTriageSnapshotSchema,
  triageCloudSignalCodeSchema, triageTriggerCodeSchema,
  type LeadTriageEvidence, type LeadTriageSnapshot, type LeadTriageSnapshotRequest,
  type TriageEvidenceCode,
} from '../../shared/contracts/leadTriageReportContract';

/** Internal projection from the facade's shared, fully ordered queue SQL. */
export type LeadTriageQueueRow = {
  cycle_id: string; person_id: string; prospect_id: string; display_name: string;
};
type CollectorInput = {
  database: AppDatabase;
  services: Pick<DomainServices, 'identities' | 'unitOfWork' | 'outboundPermission'>;
  orderedRows: readonly LeadTriageQueueRow[];
  request: LeadTriageSnapshotRequest;
  generatedAt: string;
  revisionBefore: number;
  currentRevision(): number;
};

const triggerAliases: Readonly<Record<string, LeadTriageEvidence['timing']['triggers'][number]['code']>> = {
  permit_filed: 'permit_activity', recent_permit_maintenance: 'permit_activity',
  deed_transfer: 'property_transfer', recent_acquisition: 'property_transfer',
  frbo_listing: 'rental_activity', live_vacancy: 'rental_activity', tax_season: 'tax_activity',
};
function triggerCode(value: string): LeadTriageEvidence['timing']['triggers'][number]['code'] {
  const known = triageTriggerCodeSchema.safeParse(value);
  return known.success ? known.data : Object.hasOwn(triggerAliases, value) ? triggerAliases[value]! : 'other_sanitized';
}
function cloudContributions(json: string | null): LeadTriageEvidence['cloud']['contributions'] {
  if (json === null) return [];
  let entries: unknown;
  try { entries = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return [];
    const { signal, contribution } = entry as Record<string, unknown>;
    if (typeof signal !== 'string' || typeof contribution !== 'number' || !Number.isFinite(contribution)) return [];
    const known = triageCloudSignalCodeSchema.safeParse(signal);
    return [{ signalCode: known.success ? known.data : 'other_sanitized' as const, contribution }];
  });
}

/** Synchronous SELECT-only collector. Ordered input is the normal production
 * boundary, not an override on the facade. No navigation, authorization command,
 * priority recomputation, ID allocation, filesystem, or repository write occurs.
 */
export function collectLeadTriageSnapshot(input: CollectorInput): LeadTriageSnapshot {
  const request = leadTriageSnapshotRequestSchema.parse(input.request);
  const leads: LeadTriageEvidence[] = [];
  const seen = new Set<string>();
  let scannedQueueRows = 0;
  for (const row of input.orderedRows) {
    if (leads.length === request.limit) break;
    const queueIndex = scannedQueueRows++;
    if (seen.has(row.person_id)) continue;
    seen.add(row.person_id);
    leads.push(readEvidence(input, row, leads.length + 1, queueIndex));
  }
  const snapshot = {
    generatedAt: input.generatedAt, requestedLimit: request.limit, scannedQueueRows, leads,
    revisionBefore: input.revisionBefore, revisionAfter: input.currentRevision(),
  };
  assertTriageArtifactSafe(snapshot);
  // The flag is evidence of the completed scan, never a bypass around it.
  return leadTriageSnapshotSchema.parse({ ...snapshot, privacyScanPassed: true });
}

function readEvidence(input: CollectorInput, row: LeadTriageQueueRow, rank: number, queueIndex: number): LeadTriageEvidence {
  const { database, services, generatedAt: now } = input;
  const prospect = database.raw.prepare(`SELECT qualification_state, cloud_fit, cloud_timing,
    cloud_score_reasons_json FROM prospects WHERE id = ? AND person_id = ?`)
    .get(row.prospect_id, row.person_id) as {
      qualification_state: string; cloud_fit: number | null; cloud_timing: number | null;
      cloud_score_reasons_json: string | null;
    } | undefined;
  if (prospect === undefined) throw new Error('Triage evidence is unavailable.');
  const projection = database.raw.prepare(`SELECT fit_points, fit_band, timing_millipoints,
    timing_band, reachability, data_confidence FROM prospect_priority_projection WHERE prospect_id = ?`)
    .get(row.prospect_id) as {
      fit_points: number; fit_band: 'low' | 'medium' | 'high'; timing_millipoints: number;
      timing_band: 'cold' | 'warm' | 'hot'; reachability: 'direct' | 'indirect' | 'none'; data_confidence: number;
    } | undefined;
  const organization = database.raw.prepare(`SELECT org.canonical_name AS label, link.relationship
    FROM prospect_organizations AS link JOIN organizations AS org ON org.id = link.organization_id
    WHERE link.prospect_id = ? ORDER BY org.id ASC LIMIT 1`).get(row.prospect_id) as {
      label: string; relationship: string | null;
    } | undefined;
  const property = database.raw.prepare(`SELECT property.locality, property.region, property.postal_code,
    length(trim(property.address_line_1)) > 0 AS has_address
    FROM prospect_properties AS link JOIN properties AS property ON property.id = link.property_id
    WHERE link.prospect_id = ? ORDER BY property.id ASC LIMIT 1`).get(row.prospect_id) as {
      locality: string; region: string; postal_code: string | null; has_address: number;
    } | undefined;
  // Only explicit persisted relationship codes are evidence. Unknown labels are
  // not copied and a same-name organization is not inferred to be an owner.
  const relationship = organization === undefined ? null
    : ['property_owner', 'resident', 'business_principal', 'mailing_contact'].includes(organization.relationship ?? '')
      ? organization.relationship as NonNullable<LeadTriageEvidence['organization']['relationship']>
      : 'unknown';
  const relationshipCode: TriageEvidenceCode = relationship === 'property_owner' ? 'organization_property_match'
    : relationship === 'resident' ? 'organization_residence_match'
      : relationship === 'business_principal' ? 'organization_business_match' : 'organization_relationship_unknown';
  const triggers = database.raw.prepare(`SELECT trigger_type, effective_at, expires_at FROM trigger_events
    WHERE prospect_id = ? ORDER BY effective_at ASC, id COLLATE BINARY`).all(row.prospect_id) as {
      trigger_type: string; effective_at: string; expires_at: string | null;
    }[];
  const contacts = services.identities.listContactMethodsForPerson(row.person_id);
  const jurisdictions = new JurisdictionRepository({ database, unitOfWork: services.unitOfWork });
  const jurisdiction = jurisdictions.getPersonJurisdiction(row.person_id);
  // Suppression also applies to email-only people. An unresolved read throws,
  // so there is never a success-shaped artifact asserting unknown permission.
  const suppressionBlocked = services.outboundPermission.inspectPerson(row.person_id).kind !== 'allowed';
  const refusals = new Set<OutboundAuthorizationReasonCode>();
  const states: ('verified_clear' | 'blocked' | 'unknown')[] = [];
  if (suppressionBlocked) {
    refusals.add('person_or_handle_opted_out');
    states.push('blocked');
  }
  const phones: ContactMethod[] = contacts.filter((contact) => contact.kind === 'phone').map((contact): ContactMethod => {
    // Consume the existing pure authorization evaluator and its SELECT-only
    // repositories. inspectOutbound is intentionally NOT called: it requires a
    // write scope for final execution, which a report must never acquire.
    const reason = (channel: 'call' | 'text'): OutboundAuthorizationReasonCode | null => {
      const decision = evaluateOutboundAuthorization({
        channel, now,
        personOrHandleOptedOut: suppressionBlocked,
        contact: { kind: contact.kind, normalizedValue: contact.normalizedValue,
          validationState: contact.validationState, evidence: contact.complianceEvidence },
        jurisdiction,
        clearance: jurisdiction === null ? null : jurisdictions.getClearance(jurisdiction.regionCode, channel),
        windows: FOUNDER_CHANNEL_POLICIES_V1,
      });
      if (decision.kind === 'allowed') return null;
      refusals.add(decision.reasonCode);
      return decision.reasonCode;
    };
    const callRefusalReason = reason('call');
    const textRefusalReason = reason('text');
    const reasons = [callRefusalReason, textRefusalReason];
    const clear = reasons.every((value) => value === null);
    const blocked = reasons.some((value) => value === 'federal_dnc_listed' || value === 'tcpa_blocked'
      || value === 'person_or_handle_opted_out' || value === 'jurisdiction_blocked');
    states.push(clear ? 'verified_clear' : blocked ? 'blocked' : 'unknown');
    const presentation = contact.presentationEvidence;
    return {
      id: contact.id, kind: 'phone', value: contact.normalizedValue, label: null,
      valid: contact.validationState === 'valid', validationState: contact.validationState,
      reachability: contact.reachability, sourceLabel: null,
      vendorRank: presentation?.vendorRank ?? null, phoneKind: presentation?.phoneKind ?? null,
      ownershipState: presentation?.ownershipState ?? 'unknown', evidenceObservedAt: presentation?.evidenceObservedAt ?? null,
      compliance: {
        status: reasons.includes('federal_dnc_listed') ? 'federal_dnc_listed'
          : reasons.includes('tcpa_blocked') ? 'tcpa_blocked' : clear ? 'verified_clear' : 'compliance_unknown',
        label: 'Triage evidence', expiresAt: clear ? contact.complianceEvidence.expiresAt : null,
        callRefusalReason, textRefusalReason,
      },
    };
  });
  const { primary } = selectPrimaryPhone(phones);
  const digits = primary?.value.replace(/\D/g, '') ?? '';
  const usableDirectCount = contacts.filter((contact) => contact.validationState === 'valid'
    && contact.reachability === 'direct' && contact.presentationEvidence?.ownershipState === 'verified_person').length;
  const contactCodes: TriageEvidenceCode[] = [usableDirectCount > 0 ? 'direct_contact_present' : 'no_usable_direct_contact'];
  if (contacts.some((contact) => contact.validationState === 'unverified')) contactCodes.push('contact_validation_unknown');
  if (contacts.some((contact) => contact.validationState === 'invalid')) contactCodes.push('contact_validation_invalid');
  if (contacts.some((contact) => contact.presentationEvidence?.ownershipState !== 'verified_person')) contactCodes.push('contact_ownership_unverified');
  const status = new Set(states).size > 1 ? 'mixed' : states[0] ?? 'unknown';
  if (states.includes('blocked')) contactCodes.push('compliance_blocked');
  if (status === 'verified_clear') contactCodes.push('compliance_clear');
  if (status === 'unknown' || states.includes('unknown')) contactCodes.push('compliance_unknown');
  const lastRequested = database.raw.prepare(`SELECT request.last_requested_at FROM sourcing_enrichment_requests AS request
    JOIN cloud_entity_links AS link ON link.cloud_entity_id = request.cloud_entity_id
    WHERE link.person_id = ?`).get(row.person_id) as { last_requested_at: string } | undefined;
  if (lastRequested !== undefined && new Date(now).getTime() - new Date(lastRequested.last_requested_at).getTime() < 30 * 24 * 60 * 60 * 1000) contactCodes.push('enrichment_rate_limited');
  const identityConcernCodes: TriageEvidenceCode[] = [];
  if (prospect.qualification_state === 'merge_review'
    || contacts.some((contact) => contact.presentationEvidence?.ownershipState === 'conflicting_identity')) identityConcernCodes.push('identity_collision');
  if (relationship === null || relationship === 'unknown') identityConcernCodes.push('identity_relationship_unknown');
  if (!property?.has_address) identityConcernCodes.push('identity_address_missing');
  return {
    rank, queueIndex, personId: row.person_id, salesCycleId: row.cycle_id, personName: row.display_name,
    locality: property?.locality ?? null, region: property?.region ?? null, postalCode: property?.postal_code ?? null,
    organization: { label: organization?.label ?? null, relationship, evidenceCodes: [relationshipCode] },
    fit: { points: projection?.fit_points ?? null, band: projection?.fit_band ?? null,
      evidenceCodes: [projection === undefined ? 'fit_evidence_missing' : `fit_${projection.fit_band}`] },
    timing: {
      // Frozen DTO uses whole points. Truncate persisted millipoints for display
      // only, never recompute priority or infer a band from this representation.
      value: projection === undefined ? null : Math.floor(projection.timing_millipoints / 1000),
      band: projection?.timing_band ?? null,
      triggers: triggers.map((trigger) => ({ code: triggerCode(trigger.trigger_type), observedAt: trigger.effective_at, expiresAt: trigger.expires_at })),
    },
    cloud: { fit: prospect.cloud_fit, timing: prospect.cloud_timing, contributions: cloudContributions(prospect.cloud_score_reasons_json) },
    reachability: projection?.reachability ?? null, dataConfidence: projection?.data_confidence ?? null,
    contacts: { phoneCount: phones.length, emailCount: contacts.length - phones.length, usableDirectCount,
      maskedPrimaryPhone: digits.length < 4 ? null : `••• ••• ${digits.slice(-4)}`, evidenceCodes: contactCodes },
    compliance: { status, refusalReasonCodes: [...refusals].sort() }, identityConcernCodes,
  };
}
