import type { DiscoveryEvidenceSnapshot } from '../../src/main/domain/discovery/discoveryTypes';

/** Synthetic source-supported owner/property, not a live workspace record. */
export function evidence(
  overrides: Partial<DiscoveryEvidenceSnapshot> = {},
): DiscoveryEvidenceSnapshot {
  const observedAt = '2026-09-05T12:00:00.000Z';
  return {
    personId: 'person-1', prospectId: 'prospect-1', salesCycleId: 'cycle-1',
    personName: 'Morgan Property LLC',
    personVersion: 1, prospectVersion: 1, cycleVersion: 1,
    stage: 'unreviewed', workflowStatus: 'active', qualificationState: 'unreviewed',
    qualificationGateReason: null, operationallyBlocked: false,
    unresolvedIdentity: false, identitySupported: true, resurfaceAt: null,
    originalSource: { id: 'source-1', channel: 'registry', observedAt, evidenceRef: 'registry:1' },
    properties: [{
      id: 'property-1', doorCount: 10, countryCode: 'US', region: 'RI',
      locality: 'Providence', verifiedAt: observedAt, maintenanceProfile: null,
    }],
    contacts: [], triggers: [], conflicts: [],
    validatedClaims: [{
      id: 'ownership-1', label: 'Named property owner', value: 'Morgan Property LLC',
      certainty: 'fact', refs: [{ kind: 'source', sourceEventId: 'source-1', field: 'owner', observedAt }],
    }],
    claims: [{
      id: 'ownership-1', label: 'Named property owner', value: 'Morgan Property LLC',
      certainty: 'fact', refs: [{ kind: 'source', sourceEventId: 'source-1', field: 'owner', observedAt }],
    }],
    lastConversationAt: null, conversationActivityIds: [],
    inputFingerprint: 'a'.repeat(64), ruleVersionId: 'founder-priority-v1',
    ...overrides,
  };
}
