import { z } from 'zod';
import { discoveryAssessmentSchema } from '../../shared/contracts/discoveryContract';
import { PRIORITY_PROJECTION_REBUILD_JOB_TYPE } from '../domain/startup/domainStartupTypes';
import { deriveRefreshIdempotencyKey } from '../domain/startup/priorityProjectionRefresh';
import type { JobRecord } from './jobTypes';

const shape = discoveryAssessmentSchema.shape;
export const recoveryMetadata = z.object({ kind: z.literal('discovery_recovery_v1'),
  rootJobId: z.string().min(1).refine(value => value.trim() === value) }).strict();
export const assessmentCommand = z.object({ formatVersion: z.literal(1), personId: shape.personId,
  prospectId: shape.prospectId, salesCycleId: shape.salesCycleId.nullable(), fingerprint: shape.fingerprint.nullable(),
  policyVersion: shape.policyVersion, ruleVersionId: shape.ruleVersionId, localDate: shape.localDate,
  overrideId: shape.overrideId, generation: z.union([z.literal('initial'), shape.expiresAt]),
  diagnostic: z.enum(['evidence_too_large', 'invalid_evidence']).nullable(), recovery: recoveryMetadata.optional() }).strict();
export const refreshCommand = z.object({ formatVersion: z.literal(1), jobId: z.string().min(1), evaluationId: z.string().min(1),
  prospectId: shape.prospectId, ruleVersionId: shape.ruleVersionId, founderTimezone: z.string().min(1),
  founderLocalDate: shape.localDate, evaluatedAt: shape.evaluatedAt, expectedProjectionVersion: z.number().int().positive().nullable(),
  qualifiedInputFingerprint: shape.fingerprint, refreshFingerprint: shape.fingerprint,
  reasons: z.array(z.enum(['missing_projection', 'wrong_active_rule', 'prior_founder_local_day', 'projection_expired', 'relevant_input_changed'])).min(1).max(5),
  recovery: recoveryMetadata.optional() }).strict();

export function recoveryCommand(type: string, payload: unknown) {
  if (type === 'discovery_assessment') {
    const command = assessmentCommand.parse(payload);
    if (command.diagnostic !== null || command.fingerprint === null || command.salesCycleId === null) throw new Error('DISCOVERY_INVALID_RECOVERY');
    return command;
  }
  if (type === PRIORITY_PROJECTION_REBUILD_JOB_TYPE) return refreshCommand.parse(payload);
  throw new Error('DISCOVERY_INVALID_RECOVERY');
}

export function recoveryIdentity(type: string, payload: unknown): readonly unknown[] {
  const c = recoveryCommand(type, payload);
  return 'policyVersion' in c
    ? ['discovery_recovery_v1', type, c.personId, c.prospectId, c.salesCycleId, c.fingerprint,
      c.policyVersion, c.ruleVersionId, c.localDate, c.overrideId]
    : ['discovery_recovery_v1', type, c.prospectId, c.ruleVersionId, c.founderLocalDate, c.qualifiedInputFingerprint];
}

export function recoveryKeys(type: string, payload: unknown): string[] {
  const identity = recoveryIdentity(type, payload);
  return [1, 2, 3].map(slot => JSON.stringify([...identity, slot]));
}

export function canonicalDiscoveryKey(type: string, payload: unknown): string {
  const c = recoveryCommand(type, payload);
  return 'policyVersion' in c
    ? JSON.stringify(['discovery_assessment', c.personId, c.prospectId, c.salesCycleId, c.fingerprint,
      c.policyVersion, c.ruleVersionId, c.localDate, c.overrideId, c.generation])
    : deriveRefreshIdempotencyKey(c);
}

export function hasRecovery(job: Pick<JobRecord, 'payload' | 'idempotencyKey'>): boolean {
  if (job.payload !== null && typeof job.payload === 'object' && 'recovery' in job.payload) return true;
  try { return JSON.parse(job.idempotencyKey ?? 'null')?.[0] === 'discovery_recovery_v1'; } catch { return false; }
}

export function validateRecoveryRoot(root: JobRecord, type: string, payload: unknown): void {
  recoveryMetadata.shape.rootJobId.parse(root.id);
  const command = recoveryCommand(root.type, root.payload);
  if (root.type !== type || hasRecovery(root) || root.state !== 'failed' || root.error?.code !== 'invalid_evidence'
    || root.retryCount > 3 || root.idempotencyKey !== canonicalDiscoveryKey(root.type, command)
    || JSON.stringify(recoveryIdentity(type, payload)) !== JSON.stringify(recoveryIdentity(root.type, command))
    || 'jobId' in command && command.jobId !== root.id) throw new Error('DISCOVERY_INVALID_RECOVERY');
}

export function validateRecoveryChild(child: JobRecord, root: JobRecord): number {
  const command = recoveryCommand(child.type, child.payload);
  const slot = recoveryKeys(child.type, command).indexOf(child.idempotencyKey ?? '') + 1;
  validateRecoveryRoot(root, child.type, command);
  if (!command.recovery || command.recovery.rootJobId !== root.id || slot < 1 || child.retryCount < slot || child.retryCount > 3
    || 'jobId' in command && command.jobId !== child.id) throw new Error('DISCOVERY_INVALID_RECOVERY');
  return slot;
}

export function recoveryTip(root: JobRecord, children: readonly JobRecord[]): JobRecord {
  let previous = root;
  for (const child of children) {
    if (validateRecoveryChild(child, root) !== previous.retryCount + 1 || previous.state !== 'succeeded'
      && !(previous.state === 'failed' && ['invalid_evidence', 'evidence_too_large'].includes(previous.error?.code ?? ''))) {
      throw new Error('DISCOVERY_INVALID_RECOVERY');
    }
    previous = child;
  }
  return previous;
}

export function recoveryDelay(retryCount: number): number {
  return retryCount === 0 ? 1000 : retryCount === 1 ? 5000 : 30000;
}
