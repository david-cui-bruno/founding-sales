import type { z } from "zod";
import type { askReadSchema, askRecordMatchSchema } from "@fss/contracts";
import type { RepositoryContext } from "../db/workspaceScope.ts";
import {
  activeIdentityActor,
  lockIdentityContext,
  readIdentityPerson,
  sourceAccessPredicate,
  sourceContextPredicate,
} from "./identityAccess.ts";
import { readRelationships } from "./relationships.ts";
type Input = Extract<z.infer<typeof askReadSchema>, { operation: "records" }>;
export interface AskRecordRestriction {
  firmIds?: readonly string[];
  personIds?: readonly string[];
  recordId?: string;
}
/** Names are possible matches only. Visibility and matching precede the bounded page. */
export async function readAskRecords(
  context: RepositoryContext,
  input: Input,
  restriction: AskRecordRestriction = {},
) {
  const actor = context.scope.actor;
  if (actor.kind !== "user" || !(await activeIdentityActor(context)))
    return null;
  const scope = input.scope;
  const firmIds =
    scope && "firmId" in scope ? [scope.firmId] : (restriction.firmIds ?? null);
  const personIds =
    scope && "personId" in scope
      ? [scope.personId]
      : (restriction.personIds ?? null);
  if (
    scope &&
    "firmId" in scope &&
    !(await lockIdentityContext(context, { firmIds: [scope.firmId] }))
  )
    return null;
  if (
    scope &&
    "personId" in scope &&
    !(await lockIdentityContext(context, { personIds: [scope.personId] }))
  )
    return null;
  const params = [
    context.scope.workspaceId,
    input.afterId ?? null,
    actor.role === "admin",
    actor.userId,
    input.query?.normalize("NFKC").toLocaleLowerCase("en-US") ?? "",
    firmIds,
    personIds,
    input.limit + 1,
    restriction.recordId ?? null,
  ];
  const records: z.infer<typeof askRecordMatchSchema>[] = [];
  let nextAfterId: string | null = null;
  if (input.kind === "firms") {
    const rows = (
      await context.db.query<{ id: string; name: string }>(
        `SELECT f.id,f.name FROM firms f WHERE f.workspace_id=$1 AND f.status='active' AND ($3 OR f.assigned_user_id=$4) AND ($2::uuid IS NULL OR f.id>$2) AND strpos(lower(normalize(f.name,NFKC)),$5)>0 AND ($6::uuid[] IS NULL OR f.id=ANY($6)) AND ($7::uuid[] IS NULL OR EXISTS(SELECT 1 FROM crm_legacy_contact_people b JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id WHERE b.workspace_id=f.workspace_id AND b.person_id=ANY($7) AND c.firm_id=f.id) OR EXISTS(SELECT 1 FROM crm_relationships r JOIN crm_selected_sources s ON s.workspace_id=r.workspace_id AND s.id=r.source_id WHERE r.workspace_id=f.workspace_id AND r.person_id=ANY($7) AND r.firm_id=f.id AND ${sourceAccessPredicate("$3", "$4")})) AND ($9::uuid IS NULL OR f.id=$9) ORDER BY f.id LIMIT $8`,
        params,
      )
    ).rows;
    if (
      !(await lockIdentityContext(context, {
        firmIds: rows.map((row) => row.id),
      }))
    )
      return null;
    records.push(
      ...rows.slice(0, input.limit).map((row) => ({
        recordId: row.id,
        kind: "firm" as const,
        name: row.name,
        firmId: row.id,
      })),
    );
    nextAfterId = rows.length > input.limit ? rows[input.limit - 1]!.id : null;
  } else {
    const rows = (
      await context.db.query<{
        id: string;
        full_name: string;
        firm_id: string | null;
      }>(
        `SELECT p.id,p.full_name,c.firm_id FROM crm_people p LEFT JOIN crm_legacy_contact_people b ON b.workspace_id=p.workspace_id AND b.person_id=p.id LEFT JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id LEFT JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE p.workspace_id=$1 AND ($2::uuid IS NULL OR p.id>$2) AND ($3 OR CASE WHEN b.contact_id IS NULL THEN p.owner_user_id=$4 ELSE (c.status='active' AND f.status='active' AND f.assigned_user_id=$4) OR EXISTS(SELECT 1 FROM crm_selected_sources s WHERE s.workspace_id=p.workspace_id AND s.person_id=p.id AND EXISTS(SELECT 1 FROM crm_source_relationship_contexts cx WHERE ${sourceContextPredicate()}) AND ${sourceAccessPredicate("$3", "$4")}) END) AND strpos(lower(normalize(p.full_name,NFKC)),$5)>0 AND ($7::uuid[] IS NULL OR p.id=ANY($7)) AND ($6::uuid[] IS NULL OR $7::uuid[] IS NOT NULL OR c.firm_id=ANY($6) OR EXISTS(SELECT 1 FROM crm_relationships r JOIN crm_selected_sources s ON s.workspace_id=r.workspace_id AND s.id=r.source_id WHERE r.workspace_id=p.workspace_id AND r.person_id=p.id AND r.firm_id=ANY($6) AND ${sourceAccessPredicate("$3", "$4")})) AND ($9::uuid IS NULL OR p.id=$9) ORDER BY p.id LIMIT $8`,
        params,
      )
    ).rows;
    if (
      !(await lockIdentityContext(context, {
        personIds: rows.map((row) => row.id),
        requireActiveFirms: false,
      }))
    )
      return null;
    for (const row of rows.slice(0, input.limit)) {
      const identity = await readIdentityPerson(context, row.id);
      if (!identity) continue;
      const page = await readRelationships(context, {
        personId: row.id,
        limit: 50,
      });
      if (page === null) return null;
      records.push({
        recordId: row.id,
        kind: "person",
        name: identity.fullName,
        firmId:
          identity.legacyFirmVisible &&
          (firmIds === null ||
            (row.firm_id !== null && firmIds.includes(row.firm_id)))
            ? row.firm_id
            : null,
        relationships: page.relationships
          .filter((r) => firmIds === null || firmIds.includes(r.firmId))
          .map((r) => ({
            relationshipId: r.relationshipId,
            revision: r.revision,
            firmId: r.firmId,
            firmName: r.firmName,
            status: r.status,
            startDate: r.startDate,
            endDate: r.endDate,
            sourceState: r.sourceState,
            contextReview: r.contextReview,
          })),
        relationshipsComplete: page.nextAfterId === null,
      });
    }
    nextAfterId = rows.length > input.limit ? rows[input.limit - 1]!.id : null;
  }
  if (!(await activeIdentityActor(context))) return null;
  return {
    operation: "records" as const,
    selection:
      input.afterId !== undefined || nextAfterId !== null
        ? ("unresolved" as const)
        : records.length > 1
          ? ("ambiguous" as const)
          : records.length === 1
            ? ("single" as const)
            : ("none" as const),
    records,
    nextAfterId,
    scanComplete: nextAfterId === null,
    coverage: {
      scope: "current_permitted_crm_state" as const,
      acquisition: "unverified" as const,
      semantic: "not_requested" as const,
    },
  };
}
