import { z } from "zod";
import type {
  askExplicitCorpusScopeSchema,
  askSourcesReadSchema,
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
import { readMailConversation } from "../mail/crmSources.ts";
import { createNativeCrmMailEvidence } from "./nativeMailEvidence.ts";
import {
  activeIdentityActor,
  sourceVisible,
  sourceAccessPredicate,
  sourceContextPredicate,
} from "./identityAccess.ts";

// The copy-only resolver has no processing verifier or provider composition.
const copiedMail = createNativeCrmMailEvidence();

/** Bounded transient copied-source retrieval; no processing authority, provider, or content store. */
export async function readAskCorpus(
  context: RepositoryContext,
  input: {
    scope: z.infer<typeof askExplicitCorpusScopeSchema>;
    query: string;
    limit: number;
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
    truncated: grouped.size > input.limit || truncatedSources > 0,
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
      source_id: string;
      revision: number;
      content_hash: string | null;
    }>(
      `SELECT s.id AS source_id,s.revision,s.content_hash FROM crm_selected_sources s WHERE s.workspace_id=$1 AND ($2::uuid IS NULL OR s.person_id=$2) AND ($3::uuid IS NULL OR s.firm_id=$3 OR EXISTS(SELECT 1 FROM crm_source_relationship_contexts cx WHERE ${sourceContextPredicate()} AND cx.firm_id=$3)) AND ${sourceAccessPredicate("$4", "$5")} AND ($6::text IS NULL OR ('selected_note',s.id)>($6,$7::uuid)) ORDER BY s.id LIMIT $8`,
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
    kind: "selected_note",
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
    }))
  )
    return null;
  const sources: CanonicalSourceReference[] = [];
  for (const ref of refs) {
    const resolved = await resolveCrmSource(context, ref);
    if (resolved !== null) {
      sources.push(resolved.source);
      continue;
    }
    const row = (
      await context.db.query<{
        revision: number;
        content_hash: string | null;
        availability: "deleted" | "awaiting_recapture" | "available";
        observed_at: Date;
      }>(
        "SELECT revision,content_hash,availability,observed_at FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2",
        [context.scope.workspaceId, ref.sourceId],
      )
    ).rows[0];
    if (row === undefined || row.availability === "available") return null;
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
      contentHash: null,
      locator: null,
      speaker: null,
      occurredAt: null,
      observedAt: row.observed_at.toISOString(),
      completeness: "unavailable",
      availability: row.availability,
    });
  }
  if (!(await activeIdentityActor(context))) return null;
  const last = page.at(-1);
  const nextAfter =
    candidates.length > input.limit && last !== undefined
      ? { kind: "selected_note" as const, sourceId: last.source_id }
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
      scanComplete: nextAfter === null,
      candidateCeiling: 50 as const,
    },
  };
}
