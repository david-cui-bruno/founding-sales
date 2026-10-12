import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { crmEvidenceClaimTargetSchema, crmClaimContextSchema, crmOriginalAccessClosureSchema, crmSourceLookupSchema } from "@fss/contracts";
import type { RepositoryContext } from "../db/workspaceScope.ts";
import type { AskExecutionKey } from "./askExecutionEvidence.ts";
import { activeIdentityActor } from "./identityAccess.ts";
import { lockConflictSources } from "./evidenceDecisions.ts";
import { readProcessingContext, processingContextHash } from "./processingContext.ts";
import { resolveCrmSource } from "./sourceResolver.ts";
import { createNativeCrmMailEvidence } from "./nativeMailEvidence.ts";
import { readCrmCommitmentSupportAuthority } from "./commitments.ts";
import { readAskTaskSourceAuthority } from "./askActions.ts";

export interface AskTaskDependency { kind: "ask_task" | "internal_task"; taskId: string; version: number }
const dependencySchema = z.object({ kind: z.enum(["ask_task", "internal_task"]), taskId: z.uuid(), version: z.number().int().positive() }).strict();
const receiptSchema = z.object({
  reviewId: z.uuid(), reviewRevision: z.number().int().positive(), activationKey: z.string(),
  sourceKind: crmSourceLookupSchema.shape.kind, sourceId: z.uuid(), sourceRevision: z.number().int().positive(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  anchorId: z.uuid(), decisionRevision: z.number().int().nonnegative(), contextHash: z.string(),
  initialContextSnapshot: crmClaimContextSchema, contextSnapshot: crmClaimContextSchema, originalAccessClosure: crmOriginalAccessClosureSchema,
});
const mail = createNativeCrmMailEvidence();
type Closure = z.infer<typeof crmOriginalAccessClosureSchema>;
function mergeClosures(closures: Closure[]): Closure {
  return { firmIds: [...new Set(closures.flatMap(c => c.firmIds))].sort(), personIds: [...new Set(closures.flatMap(c => c.personIds))].sort() };
}
async function internalAuthority(context: RepositoryContext, taskId: string, expectedVersion?: number) {
  const actor = context.scope.actor;
  if (actor.kind !== "user") return null;
  const task = (await context.db.query<Record<string, unknown>>("SELECT * FROM crm_internal_tasks WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3", [context.scope.workspaceId, actor.userId, taskId])).rows[0];
  if (!task || expectedVersion !== undefined && (task['version'] !== expectedVersion || task['status'] !== 'open')) return null;
  const receipt = receiptSchema.safeParse(task['activation_receipt']);
  if (!receipt.success || task['review_id'] !== receipt.data.reviewId || task['task_key'] !== receipt.data.activationKey) return null;
  const review = (await context.db.query<Record<string, unknown>>("SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3", [context.scope.workspaceId, actor.userId, receipt.data.reviewId])).rows[0];
  const target = crmEvidenceClaimTargetSchema.safeParse(review?.['target']);
  const initial = crmClaimContextSchema.safeParse(review?.['initial_context_snapshot']);
  const current = crmClaimContextSchema.safeParse(review?.['context_snapshot']);
  const closure = crmOriginalAccessClosureSchema.safeParse(review?.['original_access_closure']);
  if (!review || review['state'] === 'redacted' || !target.success || !initial.success || !current.success || !closure.success) return null;
  const original = {workspaceId: context.scope.workspaceId, kind: receipt.data.sourceKind, sourceId: receipt.data.sourceId, revision: receipt.data.sourceRevision, contentHash: receipt.data.sourceHash, locator: null};
  if (!await lockConflictSources(context, [original, target.data.source], [receipt.data.initialContextSnapshot, receipt.data.contextSnapshot, initial.data, current.data], [receipt.data.originalAccessClosure, closure.data])) return null;
  const originalContext = await readProcessingContext(context, original, mail);
  if (!originalContext || !isDeepStrictEqual(originalContext, receipt.data.contextSnapshot) || processingContextHash(originalContext) !== receipt.data.contextHash || !await resolveCrmSource(context, original, mail)) return null;
  const anchor = (await context.db.query("SELECT id FROM crm_claim_review_anchors WHERE workspace_id=$1 AND id=$2 AND availability='available' AND current_decision_revision=$3 AND context_hash=$4 FOR SHARE", [context.scope.workspaceId, receipt.data.anchorId, receipt.data.decisionRevision, receipt.data.contextHash])).rows[0];
  if (!anchor || typeof review['anchor_id'] !== 'string' || !await readCrmCommitmentSupportAuthority(context, target.data, review['anchor_id'])) return null;
  const lockedReview = (await context.db.query<Record<string, unknown>>("SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2 FOR SHARE", [context.scope.workspaceId, receipt.data.reviewId])).rows[0];
  const lockedTask = (await context.db.query<Record<string, unknown>>("SELECT * FROM crm_internal_tasks WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 FOR SHARE", [context.scope.workspaceId, actor.userId, taskId])).rows[0];
  if (!isDeepStrictEqual(review, lockedReview) || !isDeepStrictEqual(task, lockedTask)) return null;
  return {closure: mergeClosures([receipt.data.originalAccessClosure, closure.data])};
}
async function authority(context: RepositoryContext, dependency: AskTaskDependency, exactVersion: boolean) {
  return dependency.kind === 'ask_task'
    ? readAskTaskSourceAuthority(context, dependency.taskId, exactVersion ? dependency.version : undefined)
    : internalAuthority(context, dependency.taskId, exactVersion ? dependency.version : undefined);
}
async function ownerRequest(context: RepositoryContext, key: AskExecutionKey, pending: boolean) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !await activeIdentityActor(context)) return false;
  const row = (await context.db.query<Record<string, unknown>>("SELECT state,question,cancelled_at,execution_version FROM crm_ask_requests WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 AND version=$4 AND epoch=$5" + (pending ? " FOR UPDATE" : ""), [context.scope.workspaceId, actor.userId, key.requestId, key.version, key.epoch])).rows[0];
  return !!row && row['question'] !== null && !['stale','deleted'].includes(String(row['state'])) && (!pending || row['state'] === 'pending' && row['cancelled_at'] === null && row['execution_version'] === 'agent_v1');
}
export async function readAskTaskDependencyLedger(context: RepositoryContext, key: AskExecutionKey) {
  return (await context.db.query<{action_id: string | null; internal_task_id: string | null; task_version: number}>("SELECT action_id,internal_task_id,task_version FROM crm_ask_task_dependencies WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4 ORDER BY action_id NULLS LAST,internal_task_id", [context.scope.workspaceId, key.requestId, key.version, key.epoch])).rows.map(row => ({kind: row.action_id === null ? 'internal_task' as const : 'ask_task' as const, taskId: row.action_id ?? row.internal_task_id!, version: row.task_version}));
}
/** Source/action locks precede the fenced consumer. No source bodies or corpus windows are admitted. */
export async function admitAskTaskDependencies(context: RepositoryContext, key: AskExecutionKey, input: readonly AskTaskDependency[]) {
  const parsed = dependencySchema.array().max(1000).safeParse(input);
  if (!parsed.success || !await activeIdentityActor(context)) return false;
  const versions = new Map<string, number>();
  for (const dependency of parsed.data) {
    const id = `${dependency.kind}:${dependency.taskId}`;
    if (versions.has(id) && versions.get(id) !== dependency.version) return false;
    versions.set(id, dependency.version);
  }
  const dependencies = [...new Map(parsed.data.map(d => [`${d.kind}:${d.taskId}`, d])).values()].sort((a,b) => `${a.kind}:${a.taskId}`.localeCompare(`${b.kind}:${b.taskId}`));
  for (const dependency of dependencies) if (!await authority(context, dependency, true)) return false;
  if (!await ownerRequest(context, key, true)) return false;
  const existing = await readAskTaskDependencyLedger(context, key);
  const known = new Map(existing.map(d => [`${d.kind}:${d.taskId}`, d]));
  const fresh = dependencies.filter(d => !known.has(`${d.kind}:${d.taskId}`));
  if (existing.length + fresh.length > 1000) return false;
  for (const dependency of dependencies) {
    const prior = known.get(`${dependency.kind}:${dependency.taskId}`);
    if (prior && prior.version !== dependency.version) return false;
  }
  for (const dependency of fresh) await context.db.query("INSERT INTO crm_ask_task_dependencies(workspace_id,request_id,request_version,request_epoch,action_id,internal_task_id,task_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [context.scope.workspaceId, key.requestId, key.version, key.epoch, dependency.kind === 'ask_task' ? dependency.taskId : null, dependency.kind === 'internal_task' ? dependency.taskId : null, dependency.version]);
  return true;
}
/** Reuse keeps original access closure while ordinary completion remains a SQL freshness change. */
export async function readAskTaskDependencyEvidence(context: RepositoryContext, key: AskExecutionKey) {
  if (!await activeIdentityActor(context)) return null;
  const dependencies = await readAskTaskDependencyLedger(context, key);
  const closures: Closure[] = [];
  for (const dependency of dependencies) {
    const current = await authority(context, dependency, false);
    if (!current) return null;
    closures.push(current.closure);
  }
  if (!await ownerRequest(context, key, false) || !isDeepStrictEqual(dependencies, await readAskTaskDependencyLedger(context, key))) return null;
  return {dependencies, closure: mergeClosures(closures)};
}
