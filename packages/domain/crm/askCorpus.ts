import { z } from "zod";
import { createHash } from "node:crypto";
import {
  callTranscriptUtteranceSchema,
  meetingSpeechSchema,
} from "@fss/contracts";
import type {
  askExplicitCorpusScopeSchema,
  askSourcesReadSchema,
  askDiscoverySourceSchema,
  CanonicalSourceReference,
} from "@fss/contracts";
import type { RepositoryContext } from "../db/workspaceScope.ts";
import { recordCrmAuditEvent } from "./audit.ts";
import { lockConflictSources } from "./evidenceDecisions.ts";
import {
  resolveCrmSource,
  loadCrmExtractionText,
  type SourceLookup,
} from "./sourceResolver.ts";
import {
  readMailConversation,
  mailContextPredicate,
  readMailSourceState,
  snapshotMailCopyAuthorityBatch,
} from "../mail/crmSources.ts";
import { createNativeCrmMailEvidence } from "./nativeMailEvidence.ts";
import {
  activeIdentityActor,
  sourceVisible,
  sourceAccessPredicate,
  sourceContextPredicate,
} from "./identityAccess.ts";

const nativeOwner = (
  kind: string,
  id: string,
  firm: string,
  fallback: string,
) =>
  `($4::boolean OR CASE WHEN EXISTS(SELECT 1 FROM crm_extraction_generations g WHERE g.workspace_id=$1 AND g.source_kind='${kind}' AND g.source_id=${id}) THEN (SELECT coalesce(g.source_owner_user_id,g.requested_by)=$5 AND g.original_firm_id=${firm} FROM crm_extraction_generations g WHERE g.workspace_id=$1 AND g.source_kind='${kind}' AND g.source_id=${id} ORDER BY g.observed_at,g.id LIMIT 1) ELSE ${fallback} END)`;

// The copy-only resolver has no processing verifier or provider composition.
const copiedMail = createNativeCrmMailEvidence();

/** Bounded transient copied-source retrieval; no processing authority, provider, or content store. */
export async function readAskCanonicalCorpus(
  context: RepositoryContext,
  input: {
    scope: z.infer<typeof askExplicitCorpusScopeSchema>;
  },
) {
  const requested = input.scope.sources;
  if (!(await activeIdentityActor(context))) return null;
  const sources: SourceLookup[] = [];
  let refusedSources = 0;
  for (const source of [...requested].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) || a.sourceId.localeCompare(b.sourceId),
  )) {
    // A preliminary metadata-only refusal is not authority; the complete selected closure is locked next.
    if (
      source.workspaceId !== context.scope.workspaceId ||
      (source.kind === "selected_note" &&
        !(await sourceVisible(context, source.sourceId)))
    ) {
      refusedSources++;
      continue;
    }
    if (source.kind === "mail") {
      const hint =
        source.contentHash === null
          ? null
          : await snapshotMailCopyAuthorityBatch(context, [
              {
                sourceId: source.sourceId,
                sourceRevision: source.revision,
                contentHash: source.contentHash,
              },
            ]);
      const actor = context.scope.actor;
      const permittedFirms =
        hint !== null &&
        actor.kind === "user" &&
        (actor.role === "admin" ||
          (
            await context.db.query<{ denied: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM unnest($2::uuid[]) required(id) LEFT JOIN firms f ON f.workspace_id=$1 AND f.id=required.id WHERE f.id IS NULL OR f.status<>'active' OR f.assigned_user_id IS DISTINCT FROM $3::uuid) AS denied",
              [context.scope.workspaceId, hint.firmIds, actor.userId],
            )
          ).rows[0]?.denied === false);
      if (!permittedFirms) {
        refusedSources++;
        continue;
      }
    }
    if (
      source.kind === "call_transcript" ||
      source.kind === "meeting_transcript"
    ) {
      const actor = context.scope.actor;
      if (actor.kind !== "user") return null;
      const visible =
        (
          await context.db.query<{ source_id: string }>(
            source.kind === "call_transcript"
              ? `SELECT c.id AS source_id FROM call_sessions c JOIN call_transcripts t ON t.workspace_id=c.workspace_id AND t.call_session_id=c.id JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE c.workspace_id=$1 AND c.id=$2 AND t.crm_revision=$3 AND f.status='active' AND ($4::boolean OR f.assigned_user_id=$5) AND ${nativeOwner("call_transcript", "c.id", "c.firm_id", "c.actor_user_id=$5")}`
              : `SELECT t.id AS source_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id WHERE t.workspace_id=$1 AND t.id=$2 AND t.version=$3 AND f.status='active' AND ($4::boolean OR f.assigned_user_id=$5) AND ${nativeOwner("meeting_transcript", "t.id", "m.firm_id", "(r.crm_capture_owner_user_id IS NULL OR r.crm_capture_owner_user_id=$5)")}`,
            [
              context.scope.workspaceId,
              source.sourceId,
              source.revision,
              actor.role === "admin",
              actor.userId,
            ],
          )
        ).rows.length === 1;
      if (!visible) {
        refusedSources++;
        continue;
      }
    }
    sources.push(source);
  }
  if (sources.length === 0) return null;
  if (!(await lockConflictSources(context, sources))) return null;
  const windows: { text: string; source: SourceLookup; locator: string }[] = [];
  let truncatedSources = 0,
    inspectedSources = 0,
    textBytes = 0,
    omittedSignatures = 0;
  for (const source of sources) {
    if (
      source.kind === "call_transcript" ||
      source.kind === "meeting_transcript"
    ) {
      if (
        context.scope.actor.kind === "user" &&
        context.scope.actor.role === "admin"
      )
        await recordCrmAuditEvent(context, {
          action: "crm.evidence_source_read",
          subjectKind: source.kind,
          subjectId: source.sourceId,
          detail: {
            sourceRevision: source.revision,
            exceptionalAdminRead: true,
          },
        });
      const bounded = (
        await context.db.query<{ bytes: number }>(
          source.kind === "call_transcript"
            ? "SELECT octet_length(utterances::text) AS bytes FROM call_transcripts WHERE workspace_id=$1 AND call_session_id=$2 AND crm_revision=$3 FOR SHARE"
            : "SELECT octet_length(utterances::text) AS bytes FROM meeting_transcripts WHERE workspace_id=$1 AND id=$2 AND version=$3 FOR SHARE",
          [context.scope.workspaceId, source.sourceId, source.revision],
        )
      ).rows[0];
      if (bounded === undefined) {
        refusedSources++;
        continue;
      }
      if (bounded.bytes > 80000) {
        truncatedSources++;
        continue;
      }
    }
    const resolved = await resolveCrmSource(context, source, copiedMail);
    if (resolved === null) {
      refusedSources++;
      continue;
    }
    const copy =
      source.kind === "mail" && source.contentHash !== null
        ? await readMailConversation(context, {
            sourceId: source.sourceId,
            sourceRevision: source.revision,
            contentHash: source.contentHash,
          })
        : null;
    const text =
      source.kind === "mail"
        ? copy?.state === "available" &&
          copy.source.passage !== null &&
          Buffer.byteLength(copy.source.passage) <= 80000
          ? copy.source.passage
          : null
        : await loadCrmExtractionText(context, source);
    if (text === null) {
      truncatedSources++;
      continue;
    }
    inspectedSources++;
    textBytes += Buffer.byteLength(text);
    const segments =
      source.kind === "call_transcript" || source.kind === "meeting_transcript"
        ? z
            .array(
              z.object({
                utterance: z.number().int().nonnegative(),
                text: z.string(),
              }),
            )
            .parse(JSON.parse(text))
            .map((row) => ({
              text: row.text,
              prefix: `utterance:${row.utterance}:text`,
            }))
        : [{ text, prefix: "text" }];
    let sourceTruncated = false;
    for (const segment of segments) {
      const signature =
        source.kind === "mail" || source.kind === "selected_note"
          ? segment.text.indexOf("\n-- \n")
          : -1;
      if (signature >= 0) omittedSignatures++;
      const bodyEnd = signature < 0 ? segment.text.length : signature;
      for (let start = 0; start < bodyEnd;) {
        if (windows.length >= 1000) {
          sourceTruncated = true;
          break;
        }
        let end = Math.min(start + 2000, bodyEnd);
        if (
          end < bodyEnd &&
          /[\uD800-\uDBFF]/u.test(segment.text[end - 1]!) &&
          /[\uDC00-\uDFFF]/u.test(segment.text[end]!)
        )
          end--;
        windows.push({
          text: segment.text.slice(start, end),
          source,
          locator: `${segment.prefix}:${start}:${end}`,
        });
        start = end;
      }
    }
    if (sourceTruncated) truncatedSources++;
  }
  if (!(await activeIdentityActor(context))) return null;
  return {
    windows,
    coverage: {
      scope: "explicit_copied_sources" as const,
      acquisition: "unverified" as const,
      semantic: "not_requested" as const,
      scanComplete: refusedSources === 0 && truncatedSources === 0,
      requestedSources: requested.length,
      inspectedSources,
      unavailableSources: 0,
      refusedSources,
      truncatedSources,
      inspectedWindows: windows.length,
      textBytes,
      sourceByteCeiling: 80000 as const,
      textByteCeiling: 800000 as const,
      windowCeiling: 1000 as const,
      omittedSignatures,
      chunkerVersion: "lexical-original-v1" as const,
    },
  };
}

/** Existing keyword response remains a projection of the same bounded canonical census. */
export async function readAskCorpus(
 context:RepositoryContext,
 input:{scope:z.infer<typeof askExplicitCorpusScopeSchema>;query:string;limit:number},
){
 const census=await readAskCanonicalCorpus(context,{scope:input.scope});
 if(census===null)return null;
 const {windows}=census;
  const matches = (
    await context.db.query<{ ordinal: number }>(
      "SELECT ordinal::int FROM unnest($1::text[]) WITH ORDINALITY AS chunk(text,ordinal) WHERE to_tsvector('simple',text) @@ websearch_to_tsquery('simple',$2) ORDER BY ordinal",
      [windows.map((window) => window.text), input.query],
    )
  ).rows;
  const grouped = new Map<
    string,
    { text: string; sources: CanonicalSourceReference[] }
  >();
  for (const match of matches) {
    const window = windows[match.ordinal - 1]!;
    const resolved = await resolveCrmSource(
      context,
      { ...window.source, locator: window.locator },
      copiedMail,
    );
    if (resolved === null || resolved.passage?.text !== window.text)
      return null;
    const key = window.text
      .trim()
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase("en-US");
    const previous = grouped.get(key);
    if (previous === undefined)
      grouped.set(key, { text: window.text, sources: [resolved.source] });
    else previous.sources.push(resolved.source);
  }
  if (!(await activeIdentityActor(context))) return null;
  return {
    operation: "passages" as const,
    scope: input.scope,
    passages: [...grouped.values()].slice(0, input.limit),
    nextAfterSourceId: null,
    truncated: grouped.size > input.limit || census.coverage.truncatedSources > 0,
    coverage:census.coverage,
  };
}

/** Discover only explicit record associations; captured permission alone is not association. */
export async function discoverAskSources(
  context: RepositoryContext,
  input: z.infer<typeof askSourcesReadSchema>,
) {
  const actor = context.scope.actor;
  if (actor.kind !== "user" || !(await activeIdentityActor(context)))
    return null;
  const candidates = (
    await context.db.query<{
      kind: CanonicalSourceReference["kind"];
      source_id: string;
      revision: number;
      content_hash: string | null;
    }>(
      `WITH copied AS (
       SELECT 'selected_note'::text AS kind,s.id AS source_id,s.revision,s.content_hash FROM crm_selected_sources s WHERE s.workspace_id=$1 AND ($2::uuid IS NULL OR s.person_id=$2) AND ($3::uuid IS NULL OR s.firm_id=$3 OR EXISTS(SELECT 1 FROM crm_source_relationship_contexts cx WHERE ${sourceContextPredicate()} AND cx.firm_id=$3)) AND ${sourceAccessPredicate("$4", "$5")}
       UNION ALL SELECT 'mail',s.source_id,s.source_revision,s.content_hash FROM crm_mail_sources s WHERE s.workspace_id=$1 AND ($4::boolean OR s.owner_user_id=$5) AND EXISTS(SELECT 1 FROM crm_mail_source_contexts cx WHERE ${mailContextPredicate()} AND (($2::uuid IS NOT NULL AND cx.person_id=$2) OR ($3::uuid IS NOT NULL AND cx.firm_id=$3))) AND ($4::boolean OR NOT EXISTS(SELECT 1 FROM crm_mail_source_contexts cx LEFT JOIN firms f ON f.workspace_id=cx.workspace_id AND f.id=cx.firm_id WHERE ${mailContextPredicate()} AND cx.firm_id IS NOT NULL AND (f.id IS NULL OR f.status<>'active' OR f.assigned_user_id IS DISTINCT FROM $5)))
       UNION ALL SELECT 'call_transcript',c.id,t.crm_revision,NULL::text FROM call_sessions c JOIN call_transcripts t ON t.workspace_id=c.workspace_id AND t.call_session_id=c.id JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE c.workspace_id=$1 AND ($3::uuid IS NOT NULL AND c.firm_id=$3 OR $2::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM crm_extraction_generations g WHERE g.workspace_id=c.workspace_id AND g.source_kind='call_transcript' AND g.source_id=c.id AND g.source_revision=t.crm_revision AND g.context_snapshot->>'personId'=$2::text)) AND f.status='active' AND ($4::boolean OR f.assigned_user_id=$5) AND ${nativeOwner("call_transcript", "c.id", "c.firm_id", "c.actor_user_id=$5")}
       UNION ALL SELECT 'meeting_transcript',t.id,t.version,NULL::text FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id WHERE t.workspace_id=$1 AND ($3::uuid IS NOT NULL AND m.firm_id=$3 OR $2::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM crm_extraction_generations g WHERE g.workspace_id=t.workspace_id AND g.source_kind='meeting_transcript' AND g.source_id=t.id AND g.source_revision=t.version AND g.context_snapshot->>'personId'=$2::text)) AND f.status='active' AND ($4::boolean OR f.assigned_user_id=$5) AND ${nativeOwner("meeting_transcript", "t.id", "m.firm_id", "(r.crm_capture_owner_user_id IS NULL OR r.crm_capture_owner_user_id=$5)")}
      ) SELECT kind,source_id,revision,content_hash FROM copied WHERE ($6::text IS NULL OR (kind,source_id)>($6,$7::uuid)) ORDER BY kind,source_id LIMIT $8`,
      [
        context.scope.workspaceId,
        "personId" in input.scope ? input.scope.personId : null,
        "firmId" in input.scope ? input.scope.firmId : null,
        actor.role === "admin",
        actor.userId,
        input.after?.kind ?? null,
        input.after?.sourceId ?? null,
        input.limit + 1,
      ],
    )
  ).rows;
  const page = candidates.slice(0, input.limit);
  const refs: SourceLookup[] = page.map((row) => ({
    workspaceId: context.scope.workspaceId,
    kind: row.kind,
    sourceId: row.source_id,
    revision: row.revision,
    contentHash: row.content_hash,
    locator: null,
  }));
  const recordContext = {
    personId: "personId" in input.scope ? input.scope.personId : null,
    firmIds: "firmId" in input.scope ? [input.scope.firmId] : [],
    relationships: [],
    review: "current",
  };
  if (
    !(await lockConflictSources(context, refs, [recordContext], [], {
      allowUnavailable: true,
      maxSources: 50,
    }))
  )
    return null;
  const sources: z.infer<typeof askDiscoverySourceSchema>[] = [];
  let sizeBoundReached = false,
    nativeBytes = 0;
  for (const ref of refs) {
    if (ref.kind === "mail") {
      const state = await readMailSourceState(context, {
        sourceId: ref.sourceId,
      });
      if (state === null) return null;
      const row = (
        await context.db.query<{
          source_revision: number;
          content_hash: string | null;
          provider_at: Date | null;
          observed_at: Date | null;
          completeness: string;
        }>(
          "SELECT source_revision,content_hash,provider_at,observed_at,completeness FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2",
          [context.scope.workspaceId, ref.sourceId],
        )
      ).rows[0];
      if (
        row === undefined ||
        row.source_revision !== state.revision ||
        row.source_revision !== ref.revision
      )
        return null;
      if (state.availability === "available") {
        if (
          row.content_hash === null ||
          row.content_hash !== ref.contentHash ||
          row.provider_at === null ||
          row.observed_at === null
        )
          return null;
        sources.push({
          workspaceId: context.scope.workspaceId,
          kind: "mail",
          sourceId: ref.sourceId,
          revision: row.source_revision,
          contentHash: row.content_hash,
          locator: null,
          speaker: null,
          occurredAt: row.provider_at.toISOString(),
          observedAt: row.observed_at.toISOString(),
          completeness:
            row.completeness === "complete" ? "complete" : "partial",
          availability: "available",
        });
      } else {
        if (
          state.availability !== "deleted" &&
          state.availability !== "awaiting_recapture" &&
          state.availability !== "unavailable"
        )
          return null;
        sources.push({
          workspaceId: context.scope.workspaceId,
          kind: "mail",
          sourceId: ref.sourceId,
          revision: state.revision,
          contentHash: null,
          locator: null,
          speaker: null,
          occurredAt: null,
          observedAt: null,
          completeness: "unavailable",
          availability: state.availability,
        });
      }
      continue;
    }
    if (ref.kind === "selected_note") {
      const row = (
        await context.db.query<{
          revision: number;
          content_hash: string | null;
          availability: "deleted" | "awaiting_recapture" | "available";
          observed_at: Date;
          occurred_at: Date | null;
        }>(
          "SELECT revision,content_hash,availability,observed_at,occurred_at FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2",
          [context.scope.workspaceId, ref.sourceId],
        )
      ).rows[0];
      if (
        row === undefined ||
        row.revision !== ref.revision ||
        row.content_hash !== ref.contentHash
      )
        return null;
      if (actor.role === "admin")
        await recordCrmAuditEvent(context, {
          action: "crm.evidence_source_read",
          subjectKind: "selected_source",
          subjectId: ref.sourceId,
          detail: { sourceRevision: row.revision, exceptionalAdminRead: true },
        });
      sources.push({
        workspaceId: context.scope.workspaceId,
        kind: "selected_note",
        sourceId: ref.sourceId,
        revision: row.revision,
        contentHash: row.content_hash,
        locator: null,
        speaker: null,
        occurredAt: row.occurred_at?.toISOString() ?? null,
        observedAt: row.observed_at.toISOString(),
        completeness:
          row.availability === "available" ? "selected_excerpt" : "unavailable",
        availability: row.availability,
      });
      continue;
    }
    if (actor.role === "admin")
      await recordCrmAuditEvent(context, {
        action: "crm.evidence_source_read",
        subjectKind: ref.kind,
        subjectId: ref.sourceId,
        detail: { sourceRevision: ref.revision, exceptionalAdminRead: true },
      });
    const native = (
      await context.db.query<{ utterances: unknown; bytes: number }>(
        ref.kind === "call_transcript"
          ? `SELECT CASE WHEN octet_length(t.utterances::text)<=$7 THEN t.utterances ELSE NULL END AS utterances,octet_length(t.utterances::text) AS bytes FROM call_transcripts t JOIN call_sessions c ON c.workspace_id=t.workspace_id AND c.id=t.call_session_id JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE t.workspace_id=$1 AND c.id=$8 AND t.crm_revision=$6 AND ($2::uuid IS NOT NULL OR c.firm_id=$3::uuid) AND f.status='active' AND ($4::boolean OR f.assigned_user_id=$5) AND ${nativeOwner("call_transcript", "c.id", "c.firm_id", "c.actor_user_id=$5")} FOR SHARE OF t,c`
          : `SELECT CASE WHEN octet_length(t.utterances::text)<=$7 THEN t.utterances ELSE NULL END AS utterances,octet_length(t.utterances::text) AS bytes FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id WHERE t.workspace_id=$1 AND t.id=$8 AND t.version=$6 AND ($2::uuid IS NOT NULL OR m.firm_id=$3::uuid) AND f.status='active' AND ($4::boolean OR f.assigned_user_id=$5) AND ${nativeOwner("meeting_transcript", "t.id", "m.firm_id", "(r.crm_capture_owner_user_id IS NULL OR r.crm_capture_owner_user_id=$5)")} FOR SHARE OF t,r,m`,
        [
          context.scope.workspaceId,
          "personId" in input.scope ? input.scope.personId : null,
          "firmId" in input.scope ? input.scope.firmId : null,
          actor.role === "admin",
          actor.userId,
          ref.revision,
          Math.min(80000, 800000 - nativeBytes),
          ref.sourceId,
        ],
      )
    ).rows[0];
    if (native === undefined) return null;
    if (native.utterances === null) {
      sizeBoundReached = true;
      continue;
    }
    nativeBytes += Number(native.bytes);
    const parsed =
      ref.kind === "call_transcript"
        ? callTranscriptUtteranceSchema
            .array()
            .max(5000)
            .safeParse(native.utterances)
        : meetingSpeechSchema.array().max(20000).safeParse(native.utterances);
    if (!parsed.success) return null;
    const contentHash = createHash("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex");
    const exact = { ...ref, contentHash };
    const resolved = await resolveCrmSource(context, exact);
    if (resolved === null) return null;
    if ("personId" in input.scope) {
      const explicit = await context.db.query(
        "SELECT 1 FROM crm_extraction_generations WHERE workspace_id=$1 AND source_id=$2 AND source_kind=$3 AND source_revision=$4 AND source_hash=$5 AND context_snapshot->>'personId'=$6 LIMIT 1",
        [
          context.scope.workspaceId,
          ref.sourceId,
          ref.kind,
          ref.revision,
          contentHash,
          input.scope.personId,
        ],
      );
      if (explicit.rows.length !== 1) return null;
    }
    sources.push(resolved.source);
  }
  if (!(await activeIdentityActor(context))) return null;
  const last = page.at(-1);
  const nextAfter =
    candidates.length > input.limit && last !== undefined
      ? { kind: last.kind, sourceId: last.source_id }
      : null;
  return {
    operation: "sources" as const,
    scope: input.scope,
    sources,
    nextAfter,
    coverage: {
      scope: "record_copied_sources" as const,
      acquisition: "unverified" as const,
      semantic: "not_requested" as const,
      scanComplete: nextAfter === null && !sizeBoundReached,
      candidateCeiling: 50 as const,
      sizeBoundReached,
    },
  };
}
