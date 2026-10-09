import { recordCrmAuditEvent } from "./audit.ts";
import { invalidateSelectedIdentitySources } from "./identityInvalidation.ts";
import {
  prepareRecaptureContexts,
  recordRecaptureContexts,
} from "./relationships.ts";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { selectedImportPreviewSchema, instant } from "@fss/contracts";
import type {
  selectedImportInputSchema,
  selectedImportCommitSchema,
  selectedImportReadSchema,
} from "@fss/contracts";
import type { RepositoryContext } from "../db/workspaceScope.ts";
import {
  activeIdentityActor,
  lockIdentityContext,
  sourceAccessPredicate,
  readIdentityPerson,
} from "./identityAccess.ts";
import { matchEndpoint } from "./endpoints.ts";
type Input = z.infer<typeof selectedImportInputSchema>;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function previewSelectedImport(
  context: RepositoryContext,
  input: Input,
): Promise<z.infer<typeof selectedImportPreviewSchema> | null> {
  if (!(await activeIdentityActor(context))) return null;
  // Narrow parsing only: unsupported formats retain explicit unknowns.
  const participants =
    input.participants.length > 0
      ? input.participants.map((participant) => ({
          ...participant,
          provenance: "user_supplied" as const,
        }))
      : [
          ...new Set(
            input.text.match(
              /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
            ) ?? [],
          ),
        ]
          .slice(0, 20)
          .map((endpoint) => ({
            label: endpoint,
            endpoint,
            provenance: "parsed" as const,
          }));
  const dates = [
    ...input.text.matchAll(
      /^Date:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\s*$/gmu,
    ),
  ].map((match) => match[1]);
  const dated = dates.length === 1 ? dates[0] : undefined;
  const parsedDate =
    dated !== undefined && instant.safeParse(dated).success
      ? new Date(dated).toISOString()
      : null;
  const occurredAt = input.occurredAt ?? parsedDate;
  const candidates = [];
  for (const participant of participants)
    if (
      participant.endpoint !== null &&
      (participant.endpoint.includes("@") ||
        /^\+[1-9]\d{7,14}$/u.test(participant.endpoint))
    ) {
      const matched = await matchEndpoint(context, {
        kind: participant.endpoint.includes("@") ? "email" : "phone",
        value: participant.endpoint,
      });
      if (matched === null) return null;
      candidates.push({
        endpoint: participant.endpoint,
        outcome: matched.outcome,
        personId: matched.personId,
        firmId: matched.firmId,
      });
    }
  if (!(await activeIdentityActor(context))) return null;
  return selectedImportPreviewSchema.parse({
    previewHash: hash(JSON.stringify(input)),
    parserVersion: "selected-v1",
    participants,
    occurredAt,
    dateProvenance:
      input.occurredAt !== null
        ? "user_supplied"
        : parsedDate !== null
          ? "parsed"
          : "unknown",
    direction: input.direction,
    directionVerified: false,
    attribution: participants.length === 0 ? "unknown" : "asserted",
    candidates,
    warnings: [
      "Selected imported evidence; direction is unverified.",
      ...(occurredAt === null ? ["Original date unknown."] : []),
      ...(input.attachments.length > 0
        ? ["Attachment references only; content not analyzed."]
        : []),
    ],
  });
}
export async function commitSelectedImport(
  context: RepositoryContext,
  input: z.infer<typeof selectedImportCommitSchema>,
) {
  const actor = context.scope.actor;
  if (actor.kind !== "user")
    return { ok: false as const, reason: "import_access_denied" };
  const selection: Input = {
    text: input.text,
    subtype: input.subtype,
    label: input.label,
    direction: input.direction,
    participants: input.participants,
    occurredAt: input.occurredAt,
    attachments: input.attachments,
  };
  const preview = await previewSelectedImport(context, selection);
  if (preview === null || preview.previewHash !== input.previewHash)
    return { ok: false as const, reason: "import_preview_changed" };
  if (
    !(await lockIdentityContext(context, {
      personIds: input.personId === null ? [] : [input.personId],
      firmIds: input.firmId === null ? [] : [input.firmId],
    }))
  )
    return { ok: false as const, reason: "import_access_denied" };
  const keyHash = hash(input.importKey);
  await context.db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [`${context.scope.workspaceId}:${actor.userId}:import:${keyHash}`],
  );
  let old = (
    await context.db.query<{
      source_id: string;
      input_hash: string;
      person_id: string | null;
      firm_id: string | null;
      availability: string;
      source_revision: number;
      revision: number;
    }>(
      "SELECT m.source_id,m.input_hash,m.revision,s.revision AS source_revision,s.person_id,s.firm_id,s.availability FROM crm_selected_imports m JOIN crm_selected_sources s ON s.workspace_id=m.workspace_id AND s.id=m.source_id WHERE m.workspace_id=$1 AND m.owner_user_id=$2 AND m.import_key_hash=$3",
      [context.scope.workspaceId, actor.userId, keyHash],
    )
  ).rows[0];
  if (old !== undefined) {
    if (!(await lockIdentityContext(context, { sourceIds: [old.source_id] })))
      return { ok: false as const, reason: "import_access_denied" };
    old = (
      await context.db.query<typeof old>(
        "SELECT m.source_id,m.input_hash,m.revision,s.revision AS source_revision,s.person_id,s.firm_id,s.availability FROM crm_selected_imports m JOIN crm_selected_sources s ON s.workspace_id=m.workspace_id AND s.id=m.source_id WHERE m.workspace_id=$1 AND m.source_id=$2",
        [context.scope.workspaceId, old.source_id],
      )
    ).rows[0];
    if (old === undefined)
      return { ok: false as const, reason: "import_access_denied" };
    if (old.availability !== "available")
      return {
        ok: false as const,
        reason: "import_requires_explicit_recapture",
      };
    return old.input_hash === preview.previewHash &&
      old.person_id === input.personId &&
      old.firm_id === input.firmId
      ? {
          ok: true as const,
          value: {
            sourceId: old.source_id,
            sourceRevision: old.source_revision,
            metadataRevision: old.revision,
          },
        }
      : { ok: false as const, reason: "import_identity_conflict" };
  }
  if (!(await activeIdentityActor(context)))
    return { ok: false as const, reason: "import_access_denied" };
  if (
    input.personId !== null &&
    (await readIdentityPerson(context, input.personId))?.legacyFirmVisible !==
      true
  )
    return { ok: false as const, reason: "import_context_required" };
  const source = (
    await context.db.query<{ id: string }>(
      "INSERT INTO crm_selected_sources(workspace_id,person_id,firm_id,owner_user_id,source_key_hash,excerpt,content_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [
        context.scope.workspaceId,
        input.personId,
        input.firmId,
        actor.userId,
        hash(`import:${input.importKey}`),
        input.text,
        hash(input.text),
        preview.occurredAt,
      ],
    )
  ).rows[0];
  if (source === undefined) throw new Error("import_source_missing");
  await context.db.query(
    "INSERT INTO crm_selected_imports(workspace_id,source_id,owner_user_id,import_key_hash,input_hash,parser_version,subtype,label,participants,attachments,direction,attribution,date_provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)",
    [
      context.scope.workspaceId,
      source.id,
      actor.userId,
      keyHash,
      preview.previewHash,
      input.parserVersion,
      input.subtype,
      input.label,
      JSON.stringify(preview.participants),
      JSON.stringify(input.attachments),
      input.direction,
      preview.attribution,
      preview.dateProvenance,
    ],
  );
  return {
    ok: true as const,
    value: { sourceId: source.id, sourceRevision: 1, metadataRevision: 1 },
  };
}
export async function readSelectedImports(
  context: RepositoryContext,
  input: z.infer<typeof selectedImportReadSchema>,
) {
  const actor = context.scope.actor;
  if (actor.kind !== "user") return null;
  const query = () =>
    context.db.query<{
      source_id: string;
      source_revision: number;
      content_hash: string | null;
      excerpt: string | null;
      occurred_at: Date | null;
      observed_at: Date;
      availability: "available" | "deleted" | "awaiting_recapture";
      revision: number;
      subtype: Input["subtype"];
      label: string | null;
      participants: Input["participants"] | null;
      attachments: Input["attachments"] | null;
      direction: Input["direction"] | null;
      attribution: "unknown" | "asserted" | null;
      date_provenance: "parsed" | "user_supplied" | "unknown" | null;
    }>(
      `SELECT m.*,s.revision AS source_revision,s.content_hash,s.excerpt,s.occurred_at,s.observed_at,s.availability FROM crm_selected_imports m JOIN crm_selected_sources s ON s.workspace_id=m.workspace_id AND s.id=m.source_id WHERE m.workspace_id=$1 AND ($2::uuid IS NULL OR s.person_id=$2) AND ($3::uuid IS NULL OR s.firm_id=$3) AND ${sourceAccessPredicate("$4", "$5")} AND ($6::uuid IS NULL OR s.id>$6) ORDER BY s.id LIMIT $7`,
      [
        context.scope.workspaceId,
        input.personId,
        input.firmId,
        actor.role === "admin",
        actor.userId,
        input.afterId ?? null,
        input.limit + 1,
      ],
    );
  const initial = (await query()).rows;
  if (
    !(await lockIdentityContext(context, {
      personIds: input.personId === null ? [] : [input.personId],
      firmIds: input.firmId === null ? [] : [input.firmId],
      sourceIds: initial.map((row) => row.source_id),
      requireActiveFirms: false,
    }))
  )
    return null;
  const rows = (await query()).rows.filter((row) =>
    initial.some(
      (old) =>
        old.source_id === row.source_id &&
        old.source_revision === row.source_revision &&
        old.revision === row.revision,
    ),
  );
  if (!(await activeIdentityActor(context))) return null;
  if (actor.role === "admin")
    await recordCrmAuditEvent(context, {
      action: "crm.selected_import_read",
      subjectKind: input.personId === null ? "firm" : "person",
      subjectId: input.personId ?? input.firmId!,
    });
  return {
    imports: rows
      .slice(0, input.limit)
      .map((row) => ({
        source: {
          workspaceId: context.scope.workspaceId,
          sourceId: row.source_id,
          kind: "selected_note" as const,
          revision: row.source_revision,
          contentHash: row.content_hash,
          locator: row.availability === "available" ? "selected_excerpt" : null,
          speaker: null,
          occurredAt: row.occurred_at?.toISOString() ?? null,
          observedAt: row.observed_at.toISOString(),
          completeness:
            row.availability === "available"
              ? ("selected_excerpt" as const)
              : ("unavailable" as const),
          availability: row.availability,
          excerpt: row.excerpt,
        },
        metadata: {
          revision: row.revision,
          subtype: row.subtype,
          label: row.label,
          participants: row.participants,
          attachments: row.attachments,
          direction: row.direction,
          directionVerified: false as const,
          attribution: row.attribution,
          dateProvenance: row.date_provenance,
        },
      })),
    nextAfterId:
      rows.length > input.limit
        ? (rows[input.limit - 1]?.source_id ?? null)
        : null,
  };
}
export async function changeSelectedImport(
  context: RepositoryContext,
  input: {
    sourceId: string;
    expectedSourceRevision: number;
    expectedMetadataRevision: number;
  },
  action: "delete" | "restore" | "correct" | "recapture",
  selection?: Input & { previewHash: string },
) {
  const initial = (
    await context.db.query<{
      person_id: string | null;
      firm_id: string | null;
    }>(
      "SELECT person_id,firm_id FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2",
      [context.scope.workspaceId, input.sourceId],
    )
  ).rows[0];
  if (
    initial === undefined ||
    !(await lockIdentityContext(context, { sourceIds: [input.sourceId] }))
  )
    return { ok: false as const, reason: "import_access_denied" };
  const row = (
    await context.db.query<{
      source_revision: number;
      revision: number;
      availability: string;
    }>(
      "SELECT s.revision AS source_revision,m.revision,s.availability FROM crm_selected_sources s JOIN crm_selected_imports m ON m.workspace_id=s.workspace_id AND m.source_id=s.id WHERE s.workspace_id=$1 AND s.id=$2 FOR UPDATE OF m",
      [context.scope.workspaceId, input.sourceId],
    )
  ).rows[0];
  if (row === undefined)
    return { ok: false as const, reason: "import_access_denied" };
  if (
    row.source_revision !== input.expectedSourceRevision ||
    row.revision !== input.expectedMetadataRevision
  )
    return { ok: false as const, reason: "import_revision_changed" };
  if (
    (action === "restore" && row.availability !== "deleted") ||
    (action === "correct" && row.availability !== "available") ||
    (action === "recapture" && row.availability !== "awaiting_recapture")
  )
    return { ok: false as const, reason: "import_requires_explicit_recapture" };
  if (action === "correct" || action === "recapture") {
    if (selection === undefined)
      return { ok: false as const, reason: "import_preview_changed" };
    const plain: Input = {
      text: selection.text,
      subtype: selection.subtype,
      label: selection.label,
      direction: selection.direction,
      participants: selection.participants,
      occurredAt: selection.occurredAt,
      attachments: selection.attachments,
    };
    const preview = await previewSelectedImport(context, plain);
    if (preview === null || preview.previewHash !== selection.previewHash)
      return { ok: false as const, reason: "import_preview_changed" };
    const contexts = await prepareRecaptureContexts(context, input.sourceId);
    if (contexts === null)
      return { ok: false as const, reason: "source_context_limit" };
    await invalidateSelectedIdentitySources(context, [input.sourceId]);
    const contentHash = hash(selection.text);
    await context.db.query(
      "UPDATE crm_selected_sources SET excerpt=$3,content_hash=$4,occurred_at=$5,observed_at=now(),availability='available',revision=revision+1 WHERE workspace_id=$1 AND id=$2",
      [
        context.scope.workspaceId,
        input.sourceId,
        selection.text,
        contentHash,
        preview.occurredAt,
      ],
    );
    await recordRecaptureContexts(
      context,
      {
        sourceId: input.sourceId,
        revision: row.source_revision + 1,
        contentHash,
      },
      contexts,
    );
    await context.db.query(
      "UPDATE crm_selected_imports SET revision=revision+1,input_hash=$3,subtype=$4,label=$5,participants=$6::jsonb,attachments=$7::jsonb,direction=$8,attribution=$9,date_provenance=$10 WHERE workspace_id=$1 AND source_id=$2",
      [
        context.scope.workspaceId,
        input.sourceId,
        preview.previewHash,
        selection.subtype,
        selection.label,
        JSON.stringify(preview.participants),
        JSON.stringify(selection.attachments),
        selection.direction,
        preview.attribution,
        preview.dateProvenance,
      ],
    );
  } else {
    if (action === "delete" && row.availability === "deleted")
      return { ok: false as const, reason: "import_deleted" };
    await context.db.query(
      "UPDATE crm_selected_sources SET availability=$3,excerpt=NULL,content_hash=NULL,occurred_at=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2",
      [
        context.scope.workspaceId,
        input.sourceId,
        action === "delete" ? "deleted" : "awaiting_recapture",
      ],
    );
    if (action === "delete")
      await invalidateSelectedIdentitySources(context, [input.sourceId]);
  }
  return {
    ok: true as const,
    value: {
      sourceId: input.sourceId,
      sourceRevision: row.source_revision + 1,
      metadataRevision: row.revision + (action === "restore" ? 0 : 1),
    },
  };
}
