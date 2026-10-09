import {
  snapshotMailCopyAuthorityBatch,
  lockMailCopyAuthorityBatch,
} from "../mail/crmSources.ts";
import { createHash } from "node:crypto";
import {
  crmClaimContextSchema,
  crmOriginalAccessClosureSchema,
  type CrmOriginalAccessClosure,
  type CrmEvidenceDecide,
  type CrmEvidenceClaimTarget,
  type CrmConflictSave,
  type CrmConflictResolve,
  type CrmDecisionHistoryRead,
} from "@fss/contracts";
import { readCrmProcessingHealth } from "./processing.ts";
import { recordCrmAuditEvent } from "./audit.ts";
import { lockIdentityContext, activeIdentityActor } from "./identityAccess.ts";
import type { RepositoryContext } from "../db/workspaceScope.ts";
import { resolveCrmSource, type SourceLookup } from "./sourceResolver.ts";
import {
  readProcessingContext,
  processingContextHash,
} from "./processingContext.ts";
import { createNativeCrmMailEvidence } from "./nativeMailEvidence.ts";
import type { CrmMailEvidencePort } from "./mailEvidence.ts";
interface Claim extends Record<string, unknown> {
  id: string;
  generation_id: string;
  kind: "need" | "objection" | "commitment";
  interpretation: string;
  status: "stated" | "inferred";
  locator: string;
  quote: string;
  claim_hash: string;
  context_hash: string;
}
interface Anchor extends Record<string, unknown> {
  id: string;
  current_decision_revision: number;
  availability: string;
}
interface Decision extends Record<string, unknown> {
  revision: number;
  action: string;
  decision_at: Date;
  corrected_interpretation: string | null;
  rationale: string | null;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identities(
  source: SourceLookup,
  claim: Pick<
    Claim,
    "kind" | "interpretation" | "status" | "locator" | "quote" | "context_hash"
  >,
) {
  return {
    semanticHash: hash([
      "crm-human-semantic-v1",
      source.workspaceId,
      source.kind,
      source.sourceId,
      source.revision,
      source.contentHash,
      claim.context_hash,
      claim.kind,
      claim.status,
      claim.locator,
      hash(claim.quote),
      hash(claim.interpretation.trim().replace(/\s+/gu, " ")),
    ]),
    familyHash: hash([
      "crm-review-family-v1",
      source.kind,
      source.sourceId,
      claim.kind,
      claim.locator,
    ]),
    locatorHash: hash(claim.locator),
  };
}
async function currentClaims(
  context: RepositoryContext,
  source: SourceLookup,
  mail: CrmMailEvidencePort,
) {
  const canonical = await resolveCrmSource(
    context,
    { ...source, locator: null },
    mail,
  );
  if (canonical === null) return null;
  const captured = await readProcessingContext(context, source, mail);
  if (captured === null) return null;
  const contextHash = processingContextHash(captured);
  const generation = (
    await context.db.query<{ id: string; owner_user_id: string }>(
      `SELECT id,coalesce(source_owner_user_id,requested_by) AS owner_user_id FROM crm_extraction_generations WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3 AND source_revision=$4 AND source_hash=$5 AND context_hash=$6 AND state='complete' ORDER BY observed_at DESC,id DESC LIMIT 1 FOR SHARE`,
      [
        context.scope.workspaceId,
        source.kind,
        source.sourceId,
        source.revision,
        source.contentHash,
        contextHash,
      ],
    )
  ).rows[0];
  const claims =
    generation === undefined
      ? []
      : (
          await context.db.query<Claim>(
            `SELECT c.*,g.context_hash FROM crm_extraction_claims c JOIN crm_extraction_generations g ON g.workspace_id=c.workspace_id AND g.id=c.generation_id WHERE c.workspace_id=$1 AND c.generation_id=$2 ORDER BY c.id LIMIT 51`,
            [context.scope.workspaceId, generation.id],
          )
        ).rows;
  return {
    canonical,
    context: captured,
    claims,
    ownerUserId: generation?.owner_user_id ?? null,
  };
}
/** Canonical capture authority, never inferred from a claim's semantic context. */
async function originalSourceAccessClosure(
  context: RepositoryContext,
  source: SourceLookup,
): Promise<CrmOriginalAccessClosure | null> {
  if (source.kind === "selected_note") {
    const row = (
      await context.db.query<{ original_access_closure: unknown }>(
        "SELECT original_access_closure FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND content_hash=$4",
        [
          context.scope.workspaceId,
          source.sourceId,
          source.revision,
          source.contentHash,
        ],
      )
    ).rows[0];
    const parsed = crmOriginalAccessClosureSchema.safeParse(
      row?.original_access_closure,
    );
    return parsed.success ? parsed.data : null;
  }
  if (source.kind === "mail") {
    const batch = await snapshotMailCopyAuthorityBatch(context, [
      {
        sourceId: source.sourceId,
        sourceRevision: source.revision,
        contentHash: source.contentHash ?? "",
      },
    ]);
    if (batch === null) return null;
    const parsed = crmOriginalAccessClosureSchema.safeParse({
      firmIds: batch.firmIds,
      personIds: batch.personIds,
    });
    return parsed.success ? parsed.data : null;
  }
  const row = (
    await context.db.query<{ original_firm_id: string | null }>(
      "SELECT original_firm_id FROM crm_extraction_generations WHERE workspace_id=$1 AND source_id=$2 AND source_kind=$3 ORDER BY observed_at,id LIMIT 1",
      [context.scope.workspaceId, source.sourceId, source.kind],
    )
  ).rows[0];
  if (row?.original_firm_id == null) return null;
  return { firmIds: [row.original_firm_id], personIds: [] };
}
async function anchorFor(
  context: RepositoryContext,
  semanticHash: string,
  lock = false,
) {
  return (
    await context.db.query<Anchor>(
      `SELECT id,current_decision_revision,availability FROM crm_claim_review_anchors WHERE workspace_id=$1 AND semantic_hash=$2${lock ? " FOR UPDATE" : ""}`,
      [context.scope.workspaceId, semanticHash],
    )
  ).rows[0];
}
export async function readCrmEvidence(
  context: RepositoryContext,
  input: {
    source: SourceLookup;
    afterClaimId?: string | undefined;
    afterReviewedAnchorId?: string | undefined;
    limit: number;
  },
  mail: CrmMailEvidencePort = createNativeCrmMailEvidence(),
) {
  const current = await currentClaims(context, input.source, mail);
  if (current === null) return null;
  const candidates = current.claims
    .filter(
      (claim) =>
        input.afterClaimId === undefined || claim.id > input.afterClaimId,
    )
    .slice(0, input.limit);
  const reviewed = (
    await context.db.query<Claim & { history_anchor_id: string }>(
      `SELECT c.*,g.context_hash,a.id AS history_anchor_id FROM crm_claim_review_anchors a JOIN crm_extraction_claims c ON c.workspace_id=a.workspace_id AND c.id=a.original_claim_id JOIN crm_extraction_generations g ON g.workspace_id=c.workspace_id AND g.id=c.generation_id WHERE a.workspace_id=$1 AND a.source_kind=$2 AND a.source_id=$3 AND a.source_revision=$4 AND a.source_hash=$5 AND a.context_hash=$6 AND a.availability='available' AND a.current_decision_revision>0 AND a.semantic_hash<>ALL($7::text[]) AND ($8::uuid IS NULL OR a.id>$8) ORDER BY a.id LIMIT $9`,
      [
        context.scope.workspaceId,
        input.source.kind,
        input.source.sourceId,
        input.source.revision,
        input.source.contentHash,
        processingContextHash(current.context),
        current.claims.map(
          (claim) => identities(input.source, claim).semanticHash,
        ),
        input.afterReviewedAnchorId ?? null,
        input.limit + 1,
      ],
    )
  ).rows;
  const historicalCandidates = reviewed.slice(0, input.limit);
  const views = [];
  for (const claim of [...candidates, ...historicalCandidates]) {
    const evidence = await resolveCrmSource(
      context,
      { ...input.source, locator: claim.locator },
      mail,
    );
    if (evidence?.passage?.text !== claim.quote) return null;
    const identity = identities(input.source, claim),
      anchor = await anchorFor(context, identity.semanticHash);
    const decision =
      anchor?.availability === "available"
        ? (
            await context.db.query<Decision>(
              "SELECT * FROM crm_claim_decision_revisions WHERE workspace_id=$1 AND anchor_id=$2 AND revision=$3 AND redacted_at IS NULL",
              [
                context.scope.workspaceId,
                anchor.id,
                anchor.current_decision_revision,
              ],
            )
          ).rows[0]
        : undefined;
    const history =
      anchor?.availability === "available"
        ? (
            await context.db.query<Decision>(
              "SELECT * FROM crm_claim_decision_revisions WHERE workspace_id=$1 AND anchor_id=$2 AND redacted_at IS NULL ORDER BY revision DESC LIMIT 51",
              [context.scope.workspaceId, anchor.id],
            )
          ).rows
        : [];
    const changedReviewedFamily =
      decision === undefined &&
      (
        await context.db.query<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM crm_claim_review_anchors WHERE workspace_id=$1 AND review_family_hash=$2 AND semantic_hash<>$3 AND availability='available' AND current_decision_revision>0) AS exists`,
          [
            context.scope.workspaceId,
            identity.familyHash,
            identity.semanticHash,
          ],
        )
      ).rows[0]?.exists === true;
    views.push({
      decisionHistory: history.slice(0, 50).map((value) => ({
        revision: value.revision,
        action: value.action,
        decisionAt: value.decision_at.toISOString(),
        correctedInterpretation: value.corrected_interpretation,
        rationale: value.rationale,
      })),
      decisionHistoryTruncated: history.length > 50,
      reviewRequired: changedReviewedFamily,
      claimId: claim.id,
      claimRevision: 1,
      claimHash: claim.claim_hash,
      context: current.context,
      kind: claim.kind,
      interpretation: claim.interpretation,
      status: claim.status,
      quote: claim.quote,
      source: evidence.source,
      anchorId: anchor?.id ?? null,
      semanticHash: identity.semanticHash,
      decisionRevision: anchor?.current_decision_revision ?? 0,
      effectiveState:
        decision === undefined
          ? "unreviewed"
          : decision.action === "confirm"
            ? "confirmed"
            : decision.action === "dismiss"
              ? "dismissed"
              : "corrected",
      decision:
        decision === undefined
          ? null
          : {
              action: decision.action,
              decisionAt: decision.decision_at.toISOString(),
              correctedInterpretation: decision.corrected_interpretation,
              rationale: decision.rationale,
            },
    });
  }
  const nextAfterReviewedAnchorId =
    reviewed.length > input.limit
      ? (historicalCandidates.at(-1)?.history_anchor_id ?? null)
      : null;
  const nextAfterClaimId =
    current.claims.filter(
      (claim) =>
        input.afterClaimId === undefined || claim.id > input.afterClaimId,
    ).length > input.limit
      ? (candidates.at(-1)?.id ?? null)
      : null;
  const projection = {
    scope: "bounded_source_page" as const,
    counts: {
      current: candidates.length,
      reviewedHistory: historicalCandidates.length,
      confirmed: views.filter((view) => view.effectiveState === "confirmed")
        .length,
      dismissed: views.filter((view) => view.effectiveState === "dismissed")
        .length,
      corrected: views.filter((view) => view.effectiveState === "corrected")
        .length,
      unreviewed: views.filter((view) => view.effectiveState === "unreviewed")
        .length,
      reviewRequired: views.filter((view) => view.reviewRequired).length,
    },
    truncated: nextAfterClaimId !== null || nextAfterReviewedAnchorId !== null,
    revisionFingerprint: hash([
      input.source.kind,
      input.source.sourceId,
      input.source.revision,
      input.source.contentHash,
      processingContextHash(current.context),
      views.map((view) => [
        view.claimId,
        view.claimHash,
        view.semanticHash,
        view.anchorId,
        view.decisionRevision,
        view.effectiveState,
        view.reviewRequired,
      ]),
      nextAfterClaimId,
      nextAfterReviewedAnchorId,
    ]),
  };
  return {
    projection,
    source: current.canonical.source,
    claims: views.slice(0, candidates.length),
    reviewedHistory: views.slice(candidates.length),
    nextAfterReviewedAnchorId:
      reviewed.length > input.limit
        ? (historicalCandidates.at(-1)?.history_anchor_id ?? null)
        : null,
    nextAfterClaimId:
      current.claims.filter(
        (claim) =>
          input.afterClaimId === undefined || claim.id > input.afterClaimId,
      ).length > input.limit
        ? (candidates.at(-1)?.id ?? null)
        : null,
  };
}
async function supportedTargetClaim(
  context: RepositoryContext,
  source: SourceLookup,
  claimId: string,
  contextHash: string,
) {
  return (
    await context.db.query<Claim>(
      `SELECT c.*,g.context_hash FROM crm_extraction_claims c JOIN crm_extraction_generations g ON g.workspace_id=c.workspace_id AND g.id=c.generation_id WHERE c.workspace_id=$1 AND c.id=$2 AND g.source_kind=$3 AND g.source_id=$4 AND g.source_revision=$5 AND g.source_hash=$6 AND g.context_hash=$7 AND g.state='complete' FOR SHARE OF g`,
      [
        context.scope.workspaceId,
        claimId,
        source.kind,
        source.sourceId,
        source.revision,
        source.contentHash,
        contextHash,
      ],
    )
  ).rows[0];
}
export async function decideCrmEvidence(
  context: RepositoryContext,
  input: CrmEvidenceDecide,
  mail: CrmMailEvidencePort = createNativeCrmMailEvidence(),
) {
  const actor = context.scope.actor;
  if (actor.kind !== "user")
    return { ok: false as const, reason: "claim_access_denied" };
  const current = await currentClaims(context, input.source, mail);
  if (current === null)
    return { ok: false as const, reason: "source_unavailable" };
  const claim = await supportedTargetClaim(
    context,
    input.source,
    input.claimId,
    processingContextHash(current.context),
  );
  if (
    claim === undefined ||
    claim.claim_hash !== input.claimHash ||
    claim.context_hash !== input.contextHash
  )
    return { ok: false as const, reason: "claim_changed" };
  const evidence = await resolveCrmSource(
    context,
    { ...input.source, locator: claim.locator },
    mail,
  );
  if (evidence?.passage?.text !== claim.quote)
    return { ok: false as const, reason: "source_changed" };
  const originalAccessClosure = await originalSourceAccessClosure(
    context,
    input.source,
  );
  if (originalAccessClosure === null)
    return { ok: false as const, reason: "source_provenance_unavailable" };
  const identity = identities(input.source, claim);
  await context.db.query(
    `INSERT INTO crm_claim_review_anchors(workspace_id,source_kind,source_id,source_revision,source_hash,context_hash,semantic_hash,review_family_hash,claim_kind,locator_hash,original_claim_id,original_claim_hash,original_claim_revision,owner_user_id,context_snapshot,original_event_at,original_observed_at,original_access_closure) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14::jsonb,$15,$16,$17::jsonb) ON CONFLICT(workspace_id,semantic_hash) DO NOTHING`,
    [
      context.scope.workspaceId,
      input.source.kind,
      input.source.sourceId,
      input.source.revision,
      input.source.contentHash,
      input.contextHash,
      identity.semanticHash,
      identity.familyHash,
      claim.kind,
      identity.locatorHash,
      claim.id,
      claim.claim_hash,
      current.ownerUserId,
      JSON.stringify(current.context),
      current.canonical.source.occurredAt,
      current.canonical.source.observedAt,
      JSON.stringify(originalAccessClosure),
    ],
  );
  const anchor = await anchorFor(context, identity.semanticHash, true);
  if (anchor === undefined || anchor.availability !== "available")
    return { ok: false as const, reason: "decision_unavailable" };
  if (anchor.current_decision_revision !== input.expectedDecisionRevision)
    return { ok: false as const, reason: "decision_revision_conflict" };
  const revision = anchor.current_decision_revision + 1;
  await context.db.query(
    "INSERT INTO crm_claim_decision_revisions(workspace_id,anchor_id,revision,action,actor_user_id,corrected_interpretation,rationale) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      context.scope.workspaceId,
      anchor.id,
      revision,
      input.action,
      actor.userId,
      input.action === "correct" ? input.correctedInterpretation : null,
      input.rationale ?? null,
    ],
  );
  await context.db.query(
    "UPDATE crm_claim_review_anchors SET current_decision_revision=$3 WHERE workspace_id=$1 AND id=$2",
    [context.scope.workspaceId, anchor.id, revision],
  );
  return {
    ok: true as const,
    value: { anchorId: anchor.id, decisionRevision: revision },
  };
}

/** Gather the whole mixed authority closure before any copy/claim lock. */
export async function lockConflictSources(
  context: RepositoryContext,
  sources: SourceLookup[],
  snapshots: unknown[] = [],
  accessSnapshots: unknown[] = [],
) {
  if (
    sources.some((source) => source.workspaceId !== context.scope.workspaceId)
  )
    return false;
  const parsed = snapshots.map((value) =>
    crmClaimContextSchema.safeParse(value),
  );
  if (parsed.some((value) => !value.success)) return false;
  const contexts = parsed.flatMap((value) =>
    value.success ? [value.data] : [],
  );
  const accessParsed = accessSnapshots.map((value) =>
    crmOriginalAccessClosureSchema.safeParse(value),
  );
  if (accessParsed.some((value) => !value.success)) return false;
  const access = accessParsed.flatMap((value) =>
    value.success ? [value.data] : [],
  );
  const nativeSources = sources.filter(
    (source) =>
      source.kind === "call_transcript" || source.kind === "meeting_transcript",
  );
  const nativeSnapshot = async () => {
    const rows: { kind: string; sourceId: string; firmId: string | null }[] =
      [];
    for (const source of [...nativeSources].sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.sourceId.localeCompare(b.sourceId),
    )) {
      const row =
        source.kind === "call_transcript"
          ? (
              await context.db.query<{ firm_id: string }>(
                "SELECT firm_id FROM call_sessions WHERE workspace_id=$1 AND id=$2",
                [context.scope.workspaceId, source.sourceId],
              )
            ).rows[0]
          : (
              await context.db.query<{ firm_id: string }>(
                "SELECT m.firm_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND t.id=$2",
                [context.scope.workspaceId, source.sourceId],
              )
            ).rows[0];
      rows.push({
        kind: source.kind,
        sourceId: source.sourceId,
        firmId: row?.firm_id ?? null,
      });
    }
    return rows;
  };
  const nativeBefore = await nativeSnapshot();
  const mailSources = sources.filter((source) => source.kind === "mail");
  const mail = await snapshotMailCopyAuthorityBatch(
    context,
    mailSources.map((source) => ({
      sourceId: source.sourceId,
      sourceRevision: source.revision,
      contentHash: source.contentHash ?? "",
    })),
  );
  if (mail === null) return false;
  const firmIds = [
    ...new Set([
      ...contexts.flatMap((value) => value.firmIds),
      ...access.flatMap((value) => value.firmIds),
      ...mail.firmIds,
      ...nativeBefore.flatMap((row) =>
        row.firmId === null ? [] : [row.firmId],
      ),
    ]),
  ].sort();
  const personIds = [
    ...new Set([
      ...contexts.flatMap((value) =>
        value.personId === null ? [] : [value.personId],
      ),
      ...mail.personIds,
      ...access.flatMap((value) => value.personIds),
      ...contexts.flatMap(
        (value) =>
          value.mailContexts?.flatMap((entry) =>
            entry.personId === null ? [] : [entry.personId],
          ) ?? [],
      ),
    ]),
  ].sort();
  if (
    !(await lockIdentityContext(context, {
      sourceIds: [
        ...new Set(
          sources
            .filter((source) => source.kind === "selected_note")
            .map((source) => source.sourceId),
        ),
      ].sort(),
      firmIds,
      personIds,
    }))
  )
    return false;
  if (JSON.stringify(await nativeSnapshot()) !== JSON.stringify(nativeBefore))
    return false;
  return lockMailCopyAuthorityBatch(context, mail, { firmIds, personIds });
}
interface ConflictAnchor extends Anchor {
  source_kind: SourceLookup["kind"];
  source_id: string;
  source_revision: number;
  source_hash: string;
  context_hash: string;
  context_snapshot: unknown;
  owner_user_id: string;
  original_access_closure: unknown;
  original_claim_id: string;
  semantic_hash: string;
  original_event_at: Date | null;
  original_observed_at: Date | null;
}
async function conflictAnchors(context: RepositoryContext, conflictId: string) {
  return (
    await context.db.query<ConflictAnchor>(
      "SELECT DISTINCT a.* FROM crm_claim_conflict_members m JOIN crm_claim_review_anchors a ON a.workspace_id=m.workspace_id AND a.id=m.anchor_id WHERE m.workspace_id=$1 AND m.conflict_id=$2 ORDER BY a.id LIMIT 501",
      [context.scope.workspaceId, conflictId],
    )
  ).rows;
}
function sourceForAnchor(
  context: RepositoryContext,
  anchor: ConflictAnchor,
): SourceLookup {
  return {
    workspaceId: context.scope.workspaceId,
    kind: anchor.source_kind,
    sourceId: anchor.source_id,
    revision: anchor.source_revision,
    contentHash: anchor.source_hash,
    locator: null,
  };
}
async function permittedConflict(
  context: RepositoryContext,
  conflictId: string,
  mail: CrmMailEvidencePort,
) {
  const anchors = await conflictAnchors(context, conflictId);
  if (anchors.length < 2 || anchors.length > 500) return null;
  const sources = anchors.map((anchor) => sourceForAnchor(context, anchor));
  if (
    !(await lockConflictSources(
      context,
      sources,
      anchors.map((anchor) => anchor.context_snapshot),
      anchors.map((anchor) => anchor.original_access_closure),
    ))
  )
    return null;
  const actor = context.scope.actor;
  if (
    actor.kind !== "user" ||
    anchors.some(
      (anchor) =>
        anchor.availability !== "available" ||
        (actor.role !== "admin" && anchor.owner_user_id !== actor.userId),
    )
  )
    return null;
  for (const source of [...sources].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId),
  ))
    if ((await resolveCrmSource(context, source, mail)) === null) return null;
  // Membership may have changed before authority locks. Never append unknown contexts after a wait.
  const after = await conflictAnchors(context, conflictId);
  if (JSON.stringify(after) !== JSON.stringify(anchors)) return null;
  return anchors;
}
export async function targetAnchor(
  context: RepositoryContext,
  input: CrmEvidenceClaimTarget,
  mail: CrmMailEvidencePort,
) {
  const current = await currentClaims(context, input.source, mail);
  if (current === null) return null;
  const claim = await supportedTargetClaim(
    context,
    input.source,
    input.claimId,
    processingContextHash(current.context),
  );
  if (
    claim === undefined ||
    claim.claim_hash !== input.claimHash ||
    claim.context_hash !== input.contextHash
  )
    return null;
  const resolved = await resolveCrmSource(
    context,
    { ...input.source, locator: claim.locator },
    mail,
  );
  if (resolved?.passage?.text !== claim.quote) return null;
  const originalAccessClosure = await originalSourceAccessClosure(
    context,
    input.source,
  );
  if (originalAccessClosure === null) return null;
  const identity = identities(input.source, claim);
  await context.db.query(
    `INSERT INTO crm_claim_review_anchors(workspace_id,source_kind,source_id,source_revision,source_hash,context_hash,semantic_hash,review_family_hash,claim_kind,locator_hash,original_claim_id,original_claim_hash,original_claim_revision,owner_user_id,context_snapshot,original_event_at,original_observed_at,original_access_closure) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14::jsonb,$15,$16,$17::jsonb) ON CONFLICT(workspace_id,semantic_hash) DO NOTHING`,
    [
      context.scope.workspaceId,
      input.source.kind,
      input.source.sourceId,
      input.source.revision,
      input.source.contentHash,
      input.contextHash,
      identity.semanticHash,
      identity.familyHash,
      claim.kind,
      identity.locatorHash,
      claim.id,
      claim.claim_hash,
      current.ownerUserId,
      JSON.stringify(current.context),
      current.canonical.source.occurredAt,
      current.canonical.source.observedAt,
      JSON.stringify(originalAccessClosure),
    ],
  );
  const anchor = await anchorFor(context, identity.semanticHash, true);
  return anchor?.availability === "available" &&
    anchor.current_decision_revision === input.expectedDecisionRevision
    ? anchor
    : null;
}
export async function saveCrmConflict(
  context: RepositoryContext,
  input: CrmConflictSave,
  mail: CrmMailEvidencePort = createNativeCrmMailEvidence(),
) {
  const actor = context.scope.actor;
  if (actor.kind !== "user")
    return { ok: false as const, reason: "conflict_access_denied" };
  const old =
    input.conflictId === undefined
      ? []
      : await conflictAnchors(context, input.conflictId);
  if (
    !(await lockConflictSources(
      context,
      [
        ...input.members.map((member) => member.source),
        ...old.map((anchor) => sourceForAnchor(context, anchor)),
      ],
      old.map((anchor) => anchor.context_snapshot),
      old.map((anchor) => anchor.original_access_closure),
    ))
  )
    return { ok: false as const, reason: "source_unavailable" };
  if (
    input.conflictId !== undefined &&
    (await permittedConflict(context, input.conflictId, mail)) === null
  )
    return { ok: false as const, reason: "conflict_unavailable" };
  const anchors = [];
  for (const member of [...input.members].sort(
    (a, b) =>
      a.source.sourceId.localeCompare(b.source.sourceId) ||
      a.claimId.localeCompare(b.claimId),
  )) {
    const anchor = await targetAnchor(context, member, mail);
    if (anchor === null) return { ok: false as const, reason: "claim_changed" };
    anchors.push(anchor.id);
  }
  if (new Set(anchors).size !== anchors.length)
    return { ok: false as const, reason: "conflict_members_not_distinct" };
  let conflictId = input.conflictId;
  if (conflictId === undefined) {
    if (input.expectedConflictRevision !== 0)
      return { ok: false as const, reason: "conflict_revision_conflict" };
    conflictId = (
      await context.db.query<{ id: string }>(
        "INSERT INTO crm_claim_conflicts(workspace_id,current_revision) VALUES($1,1) RETURNING id",
        [context.scope.workspaceId],
      )
    ).rows[0]!.id;
  } else {
    const row = (
      await context.db.query<{ current_revision: number }>(
        "SELECT current_revision FROM crm_claim_conflicts WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [context.scope.workspaceId, conflictId],
      )
    ).rows[0];
    if (row?.current_revision !== input.expectedConflictRevision)
      return { ok: false as const, reason: "conflict_revision_conflict" };
  }
  const revision = input.expectedConflictRevision + 1;
  await context.db.query(
    "INSERT INTO crm_claim_conflict_revisions(workspace_id,conflict_id,revision,state,actor_user_id) VALUES($1,$2,$3,'open',$4)",
    [context.scope.workspaceId, conflictId, revision, actor.userId],
  );
  for (const anchor of anchors.sort())
    await context.db.query(
      "INSERT INTO crm_claim_conflict_members(workspace_id,conflict_id,revision,anchor_id) VALUES($1,$2,$3,$4)",
      [context.scope.workspaceId, conflictId, revision, anchor],
    );
  await context.db.query(
    "UPDATE crm_claim_conflicts SET current_revision=$3 WHERE workspace_id=$1 AND id=$2",
    [context.scope.workspaceId, conflictId, revision],
  );
  await context.db.query(
    "SELECT flag_crm_open_human_work($1,ARRAY(SELECT DISTINCT anchor_id FROM crm_claim_conflict_members WHERE workspace_id=$1 AND conflict_id=$2),'conflict_changed')",
    [context.scope.workspaceId, conflictId],
  );
  return { ok: true as const, value: { conflictId, revision } };
}
export async function resolveCrmConflict(
  context: RepositoryContext,
  input: CrmConflictResolve,
  mail: CrmMailEvidencePort = createNativeCrmMailEvidence(),
) {
  const actor = context.scope.actor;
  if (
    actor.kind !== "user" ||
    (await permittedConflict(context, input.conflictId, mail)) === null
  )
    return { ok: false as const, reason: "conflict_unavailable" };
  const group = (
    await context.db.query<{ current_revision: number }>(
      "SELECT current_revision FROM crm_claim_conflicts WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [context.scope.workspaceId, input.conflictId],
    )
  ).rows[0];
  if (group?.current_revision !== input.expectedConflictRevision)
    return { ok: false as const, reason: "conflict_revision_conflict" };
  const members = (
    await context.db.query<{ anchor_id: string }>(
      "SELECT anchor_id FROM crm_claim_conflict_members WHERE workspace_id=$1 AND conflict_id=$2 AND revision=$3 ORDER BY anchor_id",
      [context.scope.workspaceId, input.conflictId, group.current_revision],
    )
  ).rows;
  if (
    input.resolution === "prefer_claim" &&
    !members.some((member) => member.anchor_id === input.preferredAnchorId)
  )
    return { ok: false as const, reason: "preferred_claim_not_member" };
  const revision = group.current_revision + 1;
  await context.db.query(
    "INSERT INTO crm_claim_conflict_revisions(workspace_id,conflict_id,revision,state,resolution,preferred_anchor_id,actor_user_id,rationale) VALUES($1,$2,$3,'resolved',$4,$5,$6,$7)",
    [
      context.scope.workspaceId,
      input.conflictId,
      revision,
      input.resolution,
      input.resolution === "prefer_claim" ? input.preferredAnchorId : null,
      actor.userId,
      input.rationale ?? null,
    ],
  );
  for (const member of members)
    await context.db.query(
      "INSERT INTO crm_claim_conflict_members(workspace_id,conflict_id,revision,anchor_id) VALUES($1,$2,$3,$4)",
      [context.scope.workspaceId, input.conflictId, revision, member.anchor_id],
    );
  await context.db.query(
    "UPDATE crm_claim_conflicts SET current_revision=$3 WHERE workspace_id=$1 AND id=$2",
    [context.scope.workspaceId, input.conflictId, revision],
  );
  await context.db.query(
    "SELECT flag_crm_open_human_work($1,ARRAY(SELECT DISTINCT anchor_id FROM crm_claim_conflict_members WHERE workspace_id=$1 AND conflict_id=$2),'conflict_changed')",
    [context.scope.workspaceId, input.conflictId],
  );
  return {
    ok: true as const,
    value: { conflictId: input.conflictId, revision },
  };
}
export async function readCrmConflict(
  context: RepositoryContext,
  input: {
    conflictId: string;
    afterRevision?: number | undefined;
    limit: number;
  },
  mail: CrmMailEvidencePort = createNativeCrmMailEvidence(),
) {
  const anchors = await permittedConflict(context, input.conflictId, mail);
  if (anchors === null) return null;
  const group = (
    await context.db.query<{ current_revision: number }>(
      "SELECT current_revision FROM crm_claim_conflicts WHERE workspace_id=$1 AND id=$2 FOR SHARE",
      [context.scope.workspaceId, input.conflictId],
    )
  ).rows[0];
  if (group === undefined) return null;
  const current = (
    await context.db.query<{
      state: "open" | "resolved";
      resolution: "keep_both" | "prefer_claim" | null;
      preferred_anchor_id: string | null;
      decided_at: Date;
      rationale: string | null;
    }>(
      "SELECT * FROM crm_claim_conflict_revisions WHERE workspace_id=$1 AND conflict_id=$2 AND revision=$3",
      [context.scope.workspaceId, input.conflictId, group.current_revision],
    )
  ).rows[0];
  if (current === undefined) return null;
  const currentMembers = (
    await context.db.query<{ anchor_id: string }>(
      "SELECT anchor_id FROM crm_claim_conflict_members WHERE workspace_id=$1 AND conflict_id=$2 AND revision=$3 ORDER BY anchor_id",
      [context.scope.workspaceId, input.conflictId, group.current_revision],
    )
  ).rows;
  const members = [];
  for (const entry of currentMembers) {
    const anchor = anchors.find((value) => value.id === entry.anchor_id)!;
    const claim = (
      await context.db.query<Claim>(
        "SELECT * FROM crm_extraction_claims WHERE workspace_id=$1 AND id=$2",
        [context.scope.workspaceId, anchor.original_claim_id],
      )
    ).rows[0];
    if (claim === undefined) return null;
    const resolved = await resolveCrmSource(
      context,
      { ...sourceForAnchor(context, anchor), locator: claim.locator },
      mail,
    );
    if (resolved?.passage?.text !== claim.quote) return null;
    members.push({
      anchorId: anchor.id,
      source: resolved.source,
      claimId: claim.id,
      claimRevision: 1,
      claimHash: claim.claim_hash,
      kind: claim.kind,
      interpretation: claim.interpretation,
      status: claim.status,
      quote: claim.quote,
      context: anchor.context_snapshot,
    });
  }
  const history = (
    await context.db.query<{
      revision: number;
      state: string;
      resolution: string | null;
      preferred_anchor_id: string | null;
      decided_at: Date;
      rationale: string | null;
    }>(
      "SELECT * FROM crm_claim_conflict_revisions WHERE workspace_id=$1 AND conflict_id=$2 AND ($3::integer IS NULL OR revision>$3) ORDER BY revision LIMIT $4",
      [
        context.scope.workspaceId,
        input.conflictId,
        input.afterRevision ?? null,
        input.limit + 1,
      ],
    )
  ).rows;
  return {
    conflictId: input.conflictId,
    revision: group.current_revision,
    state: current.state,
    resolution: current.resolution,
    preferredAnchorId: current.preferred_anchor_id,
    decidedAt: current.decided_at.toISOString(),
    rationale: current.rationale,
    members,
    history: history.slice(0, input.limit).map((row) => ({
      revision: row.revision,
      state: row.state,
      resolution: row.resolution,
      preferredAnchorId: row.preferred_anchor_id,
      decidedAt: row.decided_at.toISOString(),
      rationale: row.rationale,
    })),
    nextAfterRevision:
      history.length > input.limit
        ? (history[input.limit - 1]?.revision ?? null)
        : null,
  };
}

export async function readCrmDecisionHistory(
  context: RepositoryContext,
  input: CrmDecisionHistoryRead,
  mail: CrmMailEvidencePort = createNativeCrmMailEvidence(),
) {
  const actor = context.scope.actor;
  if (actor.kind !== "user") return null;
  const anchor = (
    await context.db.query<ConflictAnchor>(
      "SELECT * FROM crm_claim_review_anchors WHERE workspace_id=$1 AND id=$2 AND source_kind=$3 AND source_id=$4",
      [context.scope.workspaceId, input.anchorId, input.kind, input.sourceId],
    )
  ).rows[0];
  if (
    anchor === undefined ||
    (actor.role !== "admin" && anchor.owner_user_id !== actor.userId)
  )
    return null;
  const snapshot = crmClaimContextSchema.safeParse(anchor.context_snapshot);
  const access = crmOriginalAccessClosureSchema.safeParse(
    anchor.original_access_closure,
  );
  if (!snapshot.success || !access.success) return null;
  const head =
    input.kind === "mail"
      ? (
          await context.db.query<{
            source_revision: number;
            content_hash: string | null;
          }>(
            "SELECT source_revision,content_hash FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2",
            [context.scope.workspaceId, input.sourceId],
          )
        ).rows[0]
      : undefined;
  if (input.kind === "mail" && head === undefined) return null;
  const batch =
    input.kind === "mail"
      ? await snapshotMailCopyAuthorityBatch(
          context,
          [
            {
              sourceId: input.sourceId,
              sourceRevision: head!.source_revision,
              contentHash: head!.content_hash ?? "",
            },
          ],
          { allowUnavailable: true },
        )
      : null;
  if (input.kind === "mail" && batch === null) return null;
  const nativeIdentity = async () =>
    input.kind === "call_transcript"
      ? (
          await context.db.query<{ firm_id: string }>(
            "SELECT firm_id FROM call_sessions WHERE workspace_id=$1 AND id=$2",
            [context.scope.workspaceId, input.sourceId],
          )
        ).rows[0]
      : input.kind === "meeting_transcript"
        ? (
            await context.db.query<{ firm_id: string }>(
              "SELECT m.firm_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND t.id=$2",
              [context.scope.workspaceId, input.sourceId],
            )
          ).rows[0]
        : undefined;
  const nativeBefore = await nativeIdentity();
  const firmIds = [
    ...new Set([
      ...snapshot.data.firmIds,
      ...access.data.firmIds,
      ...(batch?.firmIds ?? []),
      ...(nativeBefore === undefined ? [] : [nativeBefore.firm_id]),
    ]),
  ].sort();
  const personIds = [
    ...new Set([
      ...(snapshot.data.personId === null ? [] : [snapshot.data.personId]),
      ...(snapshot.data.mailContexts?.flatMap((value) =>
        value.personId === null ? [] : [value.personId],
      ) ?? []),
      ...(batch?.personIds ?? []),
      ...access.data.personIds,
    ]),
  ].sort();
  if (
    !(await lockIdentityContext(context, {
      sourceIds: input.kind === "selected_note" ? [input.sourceId] : [],
      firmIds,
      personIds,
    }))
  )
    return null;
  if (
    batch !== null &&
    !(await lockMailCopyAuthorityBatch(context, batch, { firmIds, personIds }))
  )
    return null;
  if (JSON.stringify(await nativeIdentity()) !== JSON.stringify(nativeBefore))
    return null;
  const health = await readCrmProcessingHealth(
    context,
    { sourceId: input.sourceId, kind: input.kind },
    mail,
  );
  if (health === null) return null;
  const after = (
    await context.db.query<ConflictAnchor>(
      "SELECT * FROM crm_claim_review_anchors WHERE workspace_id=$1 AND id=$2 FOR SHARE",
      [context.scope.workspaceId, input.anchorId],
    )
  ).rows[0];
  if (
    after === undefined ||
    after.owner_user_id !== anchor.owner_user_id ||
    JSON.stringify(after.original_access_closure) !==
      JSON.stringify(anchor.original_access_closure) ||
    JSON.stringify(after.context_snapshot) !==
      JSON.stringify(anchor.context_snapshot) ||
    !(await activeIdentityActor(context))
  )
    return null;
  const rows = (
    await context.db.query<Decision & { redacted_at: Date | null }>(
      "SELECT * FROM crm_claim_decision_revisions WHERE workspace_id=$1 AND anchor_id=$2 AND ($3::integer IS NULL OR revision<$3) ORDER BY revision DESC LIMIT $4",
      [
        context.scope.workspaceId,
        input.anchorId,
        input.beforeRevision ?? null,
        input.limit + 1,
      ],
    )
  ).rows;
  const currentContext =
    health.availability === "available"
      ? await readProcessingContext(
          context,
          sourceForAnchor(context, anchor),
          mail,
        )
      : null;
  const basis =
    after.availability === "deleted" || health.availability === "deleted"
      ? "deleted_redacted"
      : health.availability === "available" &&
          health.sourceRevision === anchor.source_revision &&
          currentContext !== null &&
          processingContextHash(currentContext) === anchor.context_hash
        ? "available"
        : "source_unavailable";
  if (actor.role === "admin")
    await recordCrmAuditEvent(context, {
      action: "crm.evidence_decision_history_admin_read",
      subjectKind: "crm_claim_anchor",
      subjectId: input.anchorId,
      detail: {
        sourceRevision: anchor.source_revision,
        exceptionalAdminRead: true,
      },
    });
  return {
    anchorId: input.anchorId,
    sourceId: input.sourceId,
    kind: input.kind,
    availability: health.availability,
    originalEventAt: after.original_event_at?.toISOString() ?? null,
    originalObservedAt: after.original_observed_at?.toISOString() ?? null,
    currentDecisionRevision: after.current_decision_revision,
    basis,
    decisions: rows.slice(0, input.limit).map((row) => ({
      revision: row.revision,
      action: row.action,
      decisionAt: row.decision_at.toISOString(),
      correctedInterpretation:
        basis === "available" ? row.corrected_interpretation : null,
      rationale: basis === "available" ? row.rationale : null,
      redacted: row.redacted_at !== null,
    })),
    nextBeforeRevision:
      rows.length > input.limit
        ? (rows[input.limit - 1]?.revision ?? null)
        : null,
  };
}

/** Registered publication marks support for review; it never changes task state or clears a human flag. */
export async function flagPublishedCrmEvidence(
  context: RepositoryContext,
  source: SourceLookup,
  contextHash: string,
  claims: readonly {
    kind: Claim["kind"];
    interpretation: string;
    status: Claim["status"];
    locator: string;
    quote: string;
  }[],
) {
  const semanticHashes = claims.map(
    (claim) =>
      identities(source, { ...claim, context_hash: contextHash }).semanticHash,
  );
  await context.db.query(
    `SELECT flag_crm_open_human_work($1,ARRAY(SELECT a.id FROM crm_claim_review_anchors a WHERE a.workspace_id=$1 AND a.source_kind=$2 AND a.source_id=$3 AND (a.source_revision<>$4 OR a.source_hash<>$5 OR a.context_hash<>$6)),'source_changed')`,
    [
      context.scope.workspaceId,
      source.kind,
      source.sourceId,
      source.revision,
      source.contentHash,
      contextHash,
    ],
  );
  await context.db.query(
    `SELECT flag_crm_open_human_work($1,ARRAY(SELECT a.id FROM crm_claim_review_anchors a WHERE a.workspace_id=$1 AND a.source_kind=$2 AND a.source_id=$3 AND a.source_revision=$4 AND a.source_hash=$5 AND a.context_hash=$6 AND a.semantic_hash<>ALL($7::text[])),'material_claim_changed')`,
    [
      context.scope.workspaceId,
      source.kind,
      source.sourceId,
      source.revision,
      source.contentHash,
      contextHash,
      semanticHashes,
    ],
  );
}
