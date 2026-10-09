import {
  bindCrmEvidenceWork,
  readCrmEvidenceWork,
} from "@fss/domain/crm/evidenceWork.ts";
import {
  crmEvidenceReadSchema,
  crmEvidenceDecideSchema,
  crmEvidencePageSchema,
  crmConflictSaveSchema,
  crmConflictResolveSchema,
  crmConflictReadSchema,
  crmConflictPageSchema,
  crmDecisionHistoryReadSchema,
  crmDecisionHistoryPageSchema,
  crmEvidenceWorkBindSchema,
  crmEvidenceWorkReadSchema,
  crmEvidenceWorkPageSchema,
} from "@fss/contracts";
import {
  readCrmEvidence,
  decideCrmEvidence,
  saveCrmConflict,
  resolveCrmConflict,
  readCrmConflict,
  readCrmDecisionHistory,
} from "@fss/domain/crm/evidenceDecisions.ts";
import { withTransaction } from "@fss/domain/db/queryable.ts";
import {
  contextForPrincipal,
  requirePrincipal,
  runRouteCommand,
} from "./routeSupport.ts";
import { redactError } from "../limits.ts";
import type { ApiRequest, RoutingOptions, RouteResult } from "./types.ts";
export const CRM_EVIDENCE_PATHS = [
  "/crm/evidence/read",
  "/crm/evidence/decide",
  "/crm/evidence/conflict/save",
  "/crm/evidence/conflict/resolve",
  "/crm/evidence/conflict/read",
  "/crm/evidence/decision/history/read",
  "/crm/evidence/work/bind",
  "/crm/evidence/work/read",
] as const;
export async function routeCrmEvidence(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<RouteResult | null> {
  if (!(CRM_EVIDENCE_PATHS as readonly string[]).includes(request.path))
    return null;
  if (options.auth === undefined)
    return { status: 401, body: redactError("unauthenticated") };
  const verified = await requirePrincipal(options.auth, request);
  if (!verified.ok) return verified.result;
  const scoped = contextForPrincipal(options.auth, verified.principal);
  if (!scoped.ok) return scoped.result;
  if (request.method !== "POST")
    return { status: 405, body: redactError("method_not_allowed") };
  if (request.path === "/crm/evidence/work/read") {
    const parsed = crmEvidenceWorkReadSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError("malformed_body") };
    const result = await withTransaction(options.auth.db, () =>
      readCrmEvidenceWork(scoped.context, parsed.data, options.crmMailEvidence),
    );
    return result === null
      ? { status: 404, body: redactError("not_found") }
      : { status: 200, body: crmEvidenceWorkPageSchema.parse(result) };
  }
  if (request.path === "/crm/evidence/work/bind") {
    const parsed = crmEvidenceWorkBindSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError("malformed_body") };
    const result = await runRouteCommand(
      { auth: options.auth, request, principal: verified.principal },
      crmEvidenceWorkBindSchema,
      "crm.evidence_work_bound",
      (context, body) =>
        bindCrmEvidenceWork(context, body, options.crmMailEvidence),
    );
    if (result.status !== 200) return result;
    const current = await withTransaction(options.auth.db, () =>
      readCrmEvidenceWork(
        scoped.context,
        { work: parsed.data.work, limit: 50 },
        options.crmMailEvidence,
      ),
    );
    return current === null
      ? { status: 404, body: redactError("not_found") }
      : result;
  }
  if (request.path === "/crm/evidence/decision/history/read") {
    const parsed = crmDecisionHistoryReadSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError("malformed_body") };
    const result = await withTransaction(options.auth.db, () =>
      readCrmDecisionHistory(
        scoped.context,
        parsed.data,
        options.crmMailEvidence,
      ),
    );
    return result === null
      ? { status: 404, body: redactError("not_found") }
      : { status: 200, body: crmDecisionHistoryPageSchema.parse(result) };
  }
  if (request.path.startsWith("/crm/evidence/conflict/")) {
    if (request.path.endsWith("/read")) {
      const parsed = crmConflictReadSchema.safeParse(request.body);
      if (!parsed.success)
        return { status: 400, body: redactError("malformed_body") };
      const result = await withTransaction(options.auth.db, () =>
        readCrmConflict(scoped.context, parsed.data, options.crmMailEvidence),
      );
      return result === null
        ? { status: 404, body: redactError("not_found") }
        : { status: 200, body: crmConflictPageSchema.parse(result) };
    }
    const reply = request.path.endsWith("/save")
      ? await runRouteCommand(
          { auth: options.auth, request, principal: verified.principal },
          crmConflictSaveSchema,
          "crm.conflict_saved",
          (context, body) =>
            saveCrmConflict(context, body, options.crmMailEvidence),
        )
      : await runRouteCommand(
          { auth: options.auth, request, principal: verified.principal },
          crmConflictResolveSchema,
          "crm.conflict_resolved",
          (context, body) =>
            resolveCrmConflict(context, body, options.crmMailEvidence),
        );
    if (reply.status !== 200) return reply;
    const conflictId = (reply.body as { result: { conflictId: string } }).result
      .conflictId;
    const current = await withTransaction(options.auth.db, () =>
      readCrmConflict(
        scoped.context,
        { conflictId, limit: 50 },
        options.crmMailEvidence,
      ),
    );
    return current === null
      ? { status: 404, body: redactError("not_found") }
      : reply;
  }
  if (request.path === "/crm/evidence/decide") {
    const parsed = crmEvidenceDecideSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError("malformed_body") };
    const reply = await runRouteCommand(
      { auth: options.auth, request, principal: verified.principal },
      crmEvidenceDecideSchema,
      "crm.evidence_decided",
      (context, body) =>
        decideCrmEvidence(context, body, options.crmMailEvidence),
    );
    if (reply.status !== 200) return reply;
    // A receipt keeps dated identifiers, never permission or a current decision.
    const receipt = reply.body as {
      result: { anchorId: string; decisionRevision: number };
    };
    const current = await withTransaction(options.auth.db, () =>
      readCrmDecisionHistory(
        scoped.context,
        {
          kind: parsed.data.source.kind,
          sourceId: parsed.data.source.sourceId,
          anchorId: receipt.result.anchorId,
          limit: 1,
        },
        options.crmMailEvidence,
      ),
    );
    if (current === null || current.basis === "deleted_redacted")
      return { status: 404, body: redactError("not_found") };
    if (current.basis !== "available")
      return {
        status: 409,
        body: { status: "refused", reason: "source_changed" },
      };
    if (current.currentDecisionRevision !== receipt.result.decisionRevision)
      return {
        status: 409,
        body: { status: "refused", reason: "decision_changed" },
      };
    return reply;
  }
  const parsed = crmEvidenceReadSchema.safeParse(request.body);
  if (!parsed.success)
    return { status: 400, body: redactError("malformed_body") };
  const result = await withTransaction(options.auth.db, () =>
    readCrmEvidence(scoped.context, parsed.data, options.crmMailEvidence),
  );
  return result === null
    ? { status: 404, body: redactError("not_found") }
    : { status: 200, body: crmEvidencePageSchema.parse(result) };
}
