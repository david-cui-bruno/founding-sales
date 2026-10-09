import type {
  CrmEvidenceWorkBind,
  CrmEvidenceWorkRead,
  CrmClaimContext,
} from "@fss/contracts";
import { crmClaimContextSchema } from "@fss/contracts";
import type { RepositoryContext } from "../db/workspaceScope.ts";
import type { SourceLookup } from "./sourceResolver.ts";
import { lockIdentityContext, activeIdentityActor } from "./identityAccess.ts";
import { readCrmProcessingHealth } from "./processing.ts";
import { lockConflictSources, targetAnchor } from "./evidenceDecisions.ts";
import { createNativeCrmMailEvidence } from "./nativeMailEvidence.ts";
import type { CrmMailEvidencePort } from "./mailEvidence.ts";
import { recordCrmAuditEvent } from "./audit.ts";
import { readProcessingContext } from "./processingContext.ts";
interface Work extends Record<string, unknown> {
  id: string;
  firm_id: string;
  version: string;
  status: "open" | "done" | "cancelled";
  completed_at: Date | null;
}
interface Dependency extends Record<string, unknown> {
  id: string;
  work_kind: "call_task" | "meeting_task";
  work_id: string;
  anchor_id: string;
  owner_user_id: string;
  source_kind: SourceLookup["kind"];
  source_id: string;
  source_revision: number;
  source_hash: string;
  context_snapshot: CrmClaimContext;
  original_access_closure: unknown;
  observed_work_version: string;
  observed_decision_revision: number;
  review_required: boolean;
  review_reason: string | null;
  invalidation_revision: number;
}
async function locateWork(
  context: RepositoryContext,
  work: { kind: "call_task" | "meeting_task"; id: string },
  lock = false,
) {
  const sql =
    work.kind === "meeting_task"
      ? `SELECT id,firm_id,version::text AS version,status,completed_at FROM meeting_tasks WHERE workspace_id=$1 AND id=$2${lock ? " FOR SHARE" : ""}`
      : `SELECT id,firm_id,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS version,status,completed_at FROM call_tasks WHERE workspace_id=$1 AND id=$2${lock ? " FOR SHARE" : ""}`;
  return (
    (await context.db.query<Work>(sql, [context.scope.workspaceId, work.id]))
      .rows[0] ?? null
  );
}
function workContext(firmId: string): CrmClaimContext {
  return {
    personId: null,
    firmIds: [firmId],
    relationships: [],
    review: "current",
  };
}
function sourceFor(context: RepositoryContext, row: Dependency): SourceLookup {
  return {
    workspaceId: context.scope.workspaceId,
    kind: row.source_kind,
    sourceId: row.source_id,
    revision: row.source_revision,
    contentHash: row.source_hash,
    locator: null,
  };
}
export async function bindCrmEvidenceWork(
  context: RepositoryContext,
  input: CrmEvidenceWorkBind,
  mail: CrmMailEvidencePort = createNativeCrmMailEvidence(),
) {
  const work = await locateWork(context, input.work);
  if (work === null) return { ok: false as const, reason: "work_unavailable" };
  if (
    !(await lockConflictSources(
      context,
      [input.source],
      [workContext(work.firm_id)],
    ))
  )
    return { ok: false as const, reason: "source_unavailable" };
  const sourceContext = await readProcessingContext(
    context,
    input.source,
    mail,
  );
  if (sourceContext === null || !sourceContext.firmIds.includes(work.firm_id))
    return { ok: false as const, reason: "work_source_context_mismatch" };
  const anchor = await targetAnchor(context, input, mail);
  if (anchor === null) return { ok: false as const, reason: "claim_changed" };
  const current = await locateWork(context, input.work, true);
  if (
    current === null ||
    current.firm_id !== work.firm_id ||
    current.version !== input.work.expectedVersion
  )
    return { ok: false as const, reason: "work_changed" };
  const dependency = (
    await context.db.query<{ id: string; invalidation_revision: number }>(
      `INSERT INTO crm_claim_work_dependencies(workspace_id,work_kind,work_id,anchor_id,observed_work_version,observed_decision_revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,work_kind,work_id,anchor_id) DO UPDATE SET observed_work_version=EXCLUDED.observed_work_version,observed_decision_revision=EXCLUDED.observed_decision_revision,review_required=false,review_reason=NULL,invalidation_revision=crm_claim_work_dependencies.invalidation_revision+1 RETURNING id,invalidation_revision`,
      [
        context.scope.workspaceId,
        input.work.kind,
        input.work.id,
        anchor.id,
        current.version,
        anchor.current_decision_revision,
      ],
    )
  ).rows[0]!;
  return {
    ok: true as const,
    value: {
      dependencyId: dependency.id,
      revision: dependency.invalidation_revision,
    },
  };
}
export async function readCrmEvidenceWork(
  context: RepositoryContext,
  input: CrmEvidenceWorkRead,
  _mail: CrmMailEvidencePort = createNativeCrmMailEvidence(),
) {
  const actor = context.scope.actor;
  if (actor.kind !== "user" || !(await activeIdentityActor(context)))
    return null;
  const work = await locateWork(context, input.work);
  if (work === null) return null;
  const dependencies = (
    await context.db.query<Dependency>(
      `SELECT d.*,a.owner_user_id,a.source_kind,a.source_id,a.source_revision,a.source_hash,a.context_snapshot,a.original_access_closure FROM crm_claim_work_dependencies d JOIN crm_claim_review_anchors a ON a.workspace_id=d.workspace_id AND a.id=d.anchor_id WHERE d.workspace_id=$1 AND d.work_kind=$2 AND d.work_id=$3 ORDER BY d.id LIMIT 501`,
      [context.scope.workspaceId, input.work.kind, input.work.id],
    )
  ).rows;
  if (
    dependencies.length > 500 ||
    dependencies.some(
      (row) =>
        (actor.role !== "admin" && row.owner_user_id !== actor.userId) ||
        !crmClaimContextSchema.safeParse(row.context_snapshot).success,
    )
  )
    return null;
  if (dependencies.length === 0) {
    if (!(await lockIdentityContext(context, { firmIds: [work.firm_id] })))
      return null;
  } else if (
    !(await lockConflictSources(
      context,
      dependencies.map((row) => sourceFor(context, row)),
      [
        workContext(work.firm_id),
        ...dependencies.map((row) => row.context_snapshot),
      ],
      dependencies.map((row) => row.original_access_closure),
      { allowUnavailable: true },
    ))
  )
    return null;
  const current = await locateWork(context, input.work, true);
  if (
    current === null ||
    current.firm_id !== work.firm_id ||
    !(await activeIdentityActor(context))
  )
    return null;
  const rows = (
    await context.db.query<Dependency>(
      `SELECT d.*,a.owner_user_id,a.source_kind,a.source_id,a.source_revision,a.source_hash,a.context_snapshot,a.original_access_closure FROM crm_claim_work_dependencies d JOIN crm_claim_review_anchors a ON a.workspace_id=d.workspace_id AND a.id=d.anchor_id WHERE d.workspace_id=$1 AND d.work_kind=$2 AND d.work_id=$3 ORDER BY d.id LIMIT 501`,
      [context.scope.workspaceId, input.work.kind, input.work.id],
    )
  ).rows;
  if (
    rows.map((row) => row.id).join(",") !==
    dependencies.map((row) => row.id).join(",")
  )
    return null;
  const after = rows.filter(
      (row) =>
        input.afterDependencyId === undefined ||
        row.id > input.afterDependencyId,
    ),
    page = after.slice(0, input.limit);
  if (actor.role === "admin")
    await recordCrmAuditEvent(context, {
      action: "crm.evidence_work_admin_read",
      subjectKind: input.work.kind,
      subjectId: input.work.id,
      detail: { exceptionalAdminRead: true, dependencyCount: rows.length },
    });
  if (!(await activeIdentityActor(context))) return null;
  return {
    work: {
      kind: input.work.kind,
      id: input.work.id,
      status: current.status,
      version: current.version,
      completedAt: current.completed_at?.toISOString() ?? null,
    },
    dependencies: page.map((row) => ({
      dependencyId: row.id,
      anchorId: row.anchor_id,
      source: sourceFor(context, row),
      observedDecisionRevision: row.observed_decision_revision,
      observedWorkVersion: row.observed_work_version,
      reviewRequired: row.review_required,
      reason: row.review_reason,
      revision: row.invalidation_revision,
    })),
    nextAfterDependencyId:
      after.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Replayed receipts are identities, never permission or a stale binding acknowledgement. */
export async function validateCrmEvidenceWorkReceipt(
  context: RepositoryContext,
  input: {
    work: CrmEvidenceWorkBind["work"];
    dependencyId: string;
    revision: number;
  },
  mail: CrmMailEvidencePort = createNativeCrmMailEvidence(),
) {
  const current = await readCrmEvidenceWork(
    context,
    { work: input.work, limit: 50 },
    mail,
  );
  if (current === null) return "unavailable" as const;
  const dependency = (
    await context.db.query<{
      invalidation_revision: number;
      observed_work_version: string;
    }>(
      "SELECT invalidation_revision,observed_work_version FROM crm_claim_work_dependencies WHERE workspace_id=$1 AND id=$2 AND work_kind=$3 AND work_id=$4 FOR SHARE",
      [
        context.scope.workspaceId,
        input.dependencyId,
        input.work.kind,
        input.work.id,
      ],
    )
  ).rows[0];
  if (dependency === undefined) return "unavailable" as const;
  return current.work.version === input.work.expectedVersion &&
    dependency.observed_work_version === input.work.expectedVersion &&
    dependency.invalidation_revision === input.revision
    ? ("current" as const)
    : ("changed" as const);
}

/** Real source-dependent task references, never an arbitrary task-ID entry point. */
export async function listCrmEvidenceWork(
  context: RepositoryContext,
  input: {
    kind: SourceLookup["kind"];
    sourceId: string;
    after?: { kind: "call_task" | "meeting_task"; id: string } | undefined;
    limit: number;
  },
  mail: CrmMailEvidencePort = createNativeCrmMailEvidence(),
) {
  const query = () =>
    context.db.query<{
      kind: "call_task" | "meeting_task";
      id: string;
      firm_id: string;
    }>(
      `SELECT DISTINCT d.work_kind AS kind,d.work_id AS id,coalesce(ct.firm_id,mt.firm_id) AS firm_id FROM crm_claim_work_dependencies d JOIN crm_claim_review_anchors a ON a.workspace_id=d.workspace_id AND a.id=d.anchor_id LEFT JOIN call_tasks ct ON ct.workspace_id=d.workspace_id AND ct.id=d.work_id AND d.work_kind='call_task' LEFT JOIN meeting_tasks mt ON mt.workspace_id=d.workspace_id AND mt.id=d.work_id AND d.work_kind='meeting_task' WHERE d.workspace_id=$1 AND a.source_kind=$2 AND a.source_id=$3 AND coalesce(ct.id,mt.id) IS NOT NULL AND ($4::text IS NULL OR (d.work_kind,d.work_id)>($4::text,$5::uuid)) ORDER BY kind,id LIMIT $6`,
      [
        context.scope.workspaceId,
        input.kind,
        input.sourceId,
        input.after?.kind ?? null,
        input.after?.id ?? null,
        input.limit + 1,
      ],
    );
  const before = (await query()).rows;
  const page = before.slice(0, input.limit);
  const dependencies = (
    await context.db.query<Dependency>(
      `SELECT d.*,a.owner_user_id,a.source_kind,a.source_id,a.source_revision,a.source_hash,a.context_snapshot,a.original_access_closure FROM crm_claim_work_dependencies d JOIN crm_claim_review_anchors a ON a.workspace_id=d.workspace_id AND a.id=d.anchor_id WHERE d.workspace_id=$1 AND ((d.work_kind='call_task' AND d.work_id=ANY($2::uuid[])) OR (d.work_kind='meeting_task' AND d.work_id=ANY($3::uuid[]))) ORDER BY d.id LIMIT 501`,
      [
        context.scope.workspaceId,
        page.filter((row) => row.kind === "call_task").map((row) => row.id),
        page.filter((row) => row.kind === "meeting_task").map((row) => row.id),
      ],
    )
  ).rows;
  if (
    dependencies.length > 500 ||
    !(await lockConflictSources(
      context,
      dependencies.map((row) => sourceFor(context, row)),
      [
        ...page.map((row) => workContext(row.firm_id)),
        ...dependencies.map((row) => row.context_snapshot),
      ],
      dependencies.map((row) => row.original_access_closure),
      { allowUnavailable: true },
    ))
  )
    return null;
  if (
    (await readCrmProcessingHealth(
      context,
      { kind: input.kind, sourceId: input.sourceId },
      mail,
    )) === null
  )
    return null;
  const works = [];
  for (const row of page) {
    const detail = await readCrmEvidenceWork(
      context,
      { work: { kind: row.kind, id: row.id }, limit: 50 },
      mail,
    );
    if (detail === null) return null;
    works.push({
      work: { kind: row.kind, id: row.id },
      version: detail.work.version,
      status: detail.work.status,
      completedAt: detail.work.completedAt,
      dependencyCount: dependencies.filter(
        (value) => value.work_kind === row.kind && value.work_id === row.id,
      ).length,
      reviewRequired: dependencies.some(
        (value) =>
          value.work_kind === row.kind &&
          value.work_id === row.id &&
          value.review_required,
      ),
    });
  }
  if (
    JSON.stringify((await query()).rows) !== JSON.stringify(before) ||
    !(await activeIdentityActor(context))
  )
    return null;
  return {
    works,
    nextAfter:
      before.length > input.limit && page.at(-1) !== undefined
        ? { kind: page.at(-1)!.kind, id: page.at(-1)!.id }
        : null,
  };
}
