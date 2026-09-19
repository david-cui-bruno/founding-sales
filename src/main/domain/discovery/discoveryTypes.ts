import type { DiscoveryClaim } from '../../../shared/contracts/discoveryContract';
import type { LifecycleStage } from '../../../shared/contracts/commonContract';
import type { ProspectsTable, WorkflowStatus } from '../../db/domainSchema';
import type { ContactMethodFact, OriginalSourceFact, PropertyFact, TriggerEvent } from '../prioritization/prioritizationTypes';

/**
 * Trusted collector boundary, NOT raw provider rows. The collector validates
 * source/statement existence, exact values and Person/Prospect/property linkage
 * before admitting properties/triggers. verifiedAt retains its rubric meaning,
 * not admission authority. Sourced door counts may have verifiedAt:null.
 * Profile evidenceRefs alone never prove management: unsupported dimensions
 * arrive as null/unknown; heuristics remain labeled presentation claims only.
 * Policy must not manufacture canonical inputs by parsing free-form labels.
 */
export type DiscoveryEvidenceSnapshot = Readonly<{
  personId: string; prospectId: string; salesCycleId: string; personName: string;
  personVersion: number; prospectVersion: number; cycleVersion: number;
  stage: LifecycleStage; workflowStatus: WorkflowStatus;
  qualificationState: ProspectsTable['qualification_state'];
  qualificationGateReason: string | null; operationallyBlocked: boolean;
  unresolvedIdentity: boolean; identitySupported: boolean; resurfaceAt: string | null;
  originalSource: OriginalSourceFact;
  properties: readonly PropertyFact[]; contacts: readonly ContactMethodFact[];
  triggers: readonly TriggerEvent[];
  /** Full ownership/value-validated claims, not merely the displayed subset. */
  validatedClaims: readonly DiscoveryClaim[];
  /** Bounded display selection; may also contain labeled inference/unknowns. */
  claims: readonly DiscoveryClaim[];
  /** Detected over full validated evidence BEFORE presentation truncation. */
  conflicts: readonly { kind: 'identity' | 'ownership' | 'property'; claimIds: readonly string[] }[];
  lastConversationAt: string | null;
  conversationActivityIds: readonly string[];
  inputFingerprint: string; ruleVersionId: string;
}>;
