import type { z } from 'zod';
import type { linkedinRouteRefuseSchema } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { activeIdentityActor, evidenceAvailable, lockIdentityContext } from './identityAccess.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
interface Assertion {
  person_id: string | null; firm_id: string | null; endpoint_id: string;
  source_id: string; source_revision: number; source_hash: string; source_invalidated: boolean;
  revision: number; value: string | null; [key: string]: unknown;
}
const claim = (context: RepositoryContext, id: string) => context.db.query<Assertion>(`SELECT c.*,e.value FROM crm_endpoint_claims c JOIN crm_identity_endpoints e ON e.workspace_id=c.workspace_id AND e.id=c.endpoint_id WHERE c.workspace_id=$1 AND c.id=$2 AND e.kind='linkedin'`, [context.scope.workspaceId, id]);
const relationship = (context: RepositoryContext, id: string) => context.db.query<Assertion>('SELECT * FROM crm_relationships WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, id]);
const evidence = (row: Assertion) => ({ sourceId: row.source_id, sourceRevision: row.source_revision, contentHash: row.source_hash });

/** Human stop decisions contain no profile, name or conversation content. No automatic release. */
export async function refuseLinkedinRoute(context: RepositoryContext, input: z.infer<typeof linkedinRouteRefuseSchema>) {
  await lockSendGateForStopFact(context);
  const first = (await claim(context, input.claimId)).rows[0];
  const originalRelation = (await relationship(context, input.relationshipId)).rows[0];
  if (!first || first.person_id === null || !originalRelation || originalRelation.person_id !== first.person_id || originalRelation.firm_id !== input.firmId || !await lockIdentityContext(context, { personIds: [first.person_id], firmIds: [input.firmId], sourceIds: [first.source_id, originalRelation.source_id] })) return { ok: false as const, reason: 'identity_access_denied' };
  const current = (await claim(context, input.claimId)).rows[0];
  const relation = (await relationship(context, input.relationshipId)).rows[0];
  if (current?.revision !== input.expectedRevision || current.person_id !== first.person_id || current.source_id !== first.source_id || current.endpoint_id !== first.endpoint_id) return { ok: false as const, reason: 'endpoint_revision_changed' };
  if (relation?.revision !== input.expectedRelationshipRevision || relation.person_id !== first.person_id || relation.firm_id !== input.firmId || relation.source_id !== originalRelation.source_id) return { ok: false as const, reason: 'relationship_revision_changed' };
  if (current.source_invalidated || relation.source_invalidated || current.value === null || !await evidenceAvailable(context, evidence(current)) || !await evidenceAvailable(context, evidence(relation))) return { ok: false as const, reason: 'identity_evidence_unavailable' };
  if (!await activeIdentityActor(context) || context.scope.actor.kind !== 'user') return { ok: false as const, reason: 'identity_access_denied' };
  const row = (await context.db.query<{ id: string }>(`INSERT INTO linkedin_route_refusals(workspace_id,person_id,firm_id,endpoint_id,claim_id,claim_revision,relationship_id,relationship_revision,scope,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [context.scope.workspaceId, current.person_id, input.firmId, current.endpoint_id, input.claimId, current.revision, input.relationshipId, relation.revision, input.scope, context.scope.actor.userId])).rows[0]!;
  await recordCrmAuditEvent(context, { action: 'crm.linkedin_refusal_recorded', subjectKind: 'person', subjectId: current.person_id!, detail: { refusalId: row.id, scope: input.scope, firmId: input.firmId, endpointId: current.endpoint_id, claimId: input.claimId, claimRevision: current.revision, relationshipId: input.relationshipId, relationshipRevision: relation.revision } });
  return { ok: true as const, value: { refusalId: row.id, scope: input.scope } };
}
