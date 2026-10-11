import type { AskAgentScope } from "@fss/contracts";
import type { RepositoryContext } from "../db/workspaceScope.ts";
import { readAsk } from "./ask.ts";
import { resolveAskAgentScope, askToolFirmIds } from "./askAgentScope.ts";
import { readAskRecords } from "./askRecords.ts";
import { readRelationships } from "./relationships.ts";
import { readPerson } from "./people.ts";
async function restriction(context: RepositoryContext, intent: AskAgentScope) {
  if (intent.kind === "business") return {};
  if (intent.kind === "firm") return { firmIds: [intent.firmId] };
  if (intent.kind === "person") return { personIds: [intent.personId] };
  const scope = await resolveAskAgentScope(context, intent);
  return scope === null
    ? null
    : { firmIds: scope.firmIds, personIds: scope.personIds };
}
/** Intent comes from the immutable server request, not tool arguments. */
export async function readAskInvestigationRecords(
  context: RepositoryContext,
  input: {
    intent: AskAgentScope;
    query?: string | undefined;
    kind: "people" | "firms";
    limit?: number | undefined;
    afterId?: string | undefined;
  },
) {
  const allowed = await restriction(context, input.intent);
  if (allowed === null) return null;
  if (input.intent.kind === "person" && input.kind === "firms") {
    const person = await readPerson(context, input.intent.personId, {
      limit: 1,
    });
    if (person === null) return null;
    const relationships = await readRelationships(context, {
      personId: input.intent.personId,
      limit: 50,
    });
    if (relationships === null || relationships.nextAfterId !== null)
      return null;
    const firmIds = [
      ...new Set([
        ...(person.person.firm ? [person.person.firm.firmId] : []),
        ...relationships.relationships
          .filter(
            (r) =>
              r.sourceState === "available" && r.contextReview === "current",
          )
          .map((r) => r.firmId),
      ]),
    ];
    return readAskRecords(
      context,
      {
        operation: "records",
        kind: "firms",
        query: input.query,
        afterId: input.afterId,
        limit: input.limit ?? 20,
      },
      { firmIds },
    );
  }
  return readAskRecords(
    context,
    {
      operation: "records",
      query: input.query,
      kind: input.kind,
      afterId: input.afterId,
      limit: input.limit ?? 20,
    },
    input.intent.kind === "selected" && input.kind === "firms"
      ? { firmIds: allowed.firmIds ?? [] }
      : allowed,
  );
}
export async function readAskInvestigationExact(
  context: RepositoryContext,
  input: {
    intent: AskAgentScope;
    operation: "tasks" | "opportunities" | "reply_status";
    firmId?: string | undefined;
    limit?: number | undefined;
    status?: "open" | "all" | undefined;
  },
) {
  const intent = input.intent;
  let firmId = input.firmId;
  if (intent.kind === "firm") {
    if (firmId !== undefined && firmId !== intent.firmId) return null;
    firmId = intent.firmId;
  }
  if (
    intent.kind === "person" &&
    input.operation === "tasks" &&
    firmId === undefined
  )
    return readAsk(context, {
      operation: "tasks",
      scope: {
        personId: intent.personId,
        ...(intent.from === undefined ? {} : { from: intent.from }),
        ...(intent.to === undefined ? {} : { to: intent.to }),
      },
      limit: input.limit ?? 20,
    });
  if (intent.kind === "person") {
    const page = await readAskInvestigationRecords(context, {
      intent,
      kind: "firms",
      limit: 50,
    });
    if (page === null || !page.scanComplete) return null;
    const firms = page.records.map((row) => row.recordId);
    if (firmId === undefined) {
      if (firms.length !== 1) return null;
      firmId = firms[0];
    } else if (!firms.includes(firmId)) return null;
  }
  if (intent.kind === "selected") {
    const resolved = await resolveAskAgentScope(context, intent);
    if (resolved === null) return null;
    const firms = askToolFirmIds(intent, resolved.firmIds);
    if (firmId === undefined) {
      if (firms.length !== 1) return null;
      firmId = firms[0];
    } else if (!firms.includes(firmId)) return null;
  }
  const dates = {
    ...(intent.from === undefined ? {} : { from: intent.from }),
    ...(intent.to === undefined ? {} : { to: intent.to }),
  };
  const scope =
    firmId === undefined
      ? { business: true as const, ...dates }
      : { firmId, ...dates };
  if (input.operation === "reply_status")
    return readAsk(context, { operation: "reply_status", scope });
  if (input.operation === "tasks")
    return readAsk(context, {
      operation: "tasks",
      scope,
      limit: input.limit ?? 20,
    });
  return readAsk(context, {
    operation: "opportunities",
    scope,
    status: input.status ?? "open",
    limit: input.limit ?? 20,
  });
}
/** Compatibility names used by the executor; no access decision comes from model input. */
export async function resolveAskRecords(
  context: RepositoryContext,
  intent: AskAgentScope | null,
  input: {
    query?: string | undefined;
    kind?: "firm" | "person" | undefined;
    limit?: number | undefined;
    afterId?: string | undefined;
  },
) {
  if (intent === null) return null;
  if (input.kind)
    return readAskInvestigationRecords(context, {
      intent,
      query: input.query,
      kind: input.kind === "firm" ? "firms" : "people",
      limit: input.limit,
      afterId: input.afterId,
    });
  const firms = await readAskInvestigationRecords(context, {
    intent,
    query: input.query,
    kind: "firms",
    limit: input.limit,
    afterId: input.afterId,
  });
  const people = await readAskInvestigationRecords(context, {
    intent,
    query: input.query,
    kind: "people",
    limit: input.limit,
    afterId: input.afterId,
  });
  if (firms === null || people === null) return null;
  const all = [...firms.records, ...people.records];
  const limit = input.limit ?? 20;
  const partial =
    !firms.scanComplete || !people.scanComplete || all.length > limit;
  return {
    ...firms,
    records: all.slice(0, limit),
    selection: partial
      ? ("unresolved" as const)
      : all.length > 1
        ? ("ambiguous" as const)
        : all.length === 1
          ? ("single" as const)
          : ("none" as const),
    scanComplete: !partial,
  };
}
export async function readAskScopedExact(
  context: RepositoryContext,
  intent: AskAgentScope | null,
  input: {
    operation: "tasks" | "opportunities" | "reply_status";
    firmId?: string | undefined;
    limit?: number | undefined;
    status?: "open" | "all" | undefined;
  },
) {
  return intent === null
    ? null
    : readAskInvestigationExact(context, { intent, ...input });
}
