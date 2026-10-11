import { isDeepStrictEqual } from "node:util";
import { readAskExecutionEvidence } from "./askExecutionEvidence.ts";
import { readAskConversationAttribution } from "./askHistoryInvestigation.ts";
import { resolveCrmSource } from "./sourceResolver.ts";
import { createNativeCrmMailEvidence } from "./nativeMailEvidence.ts";
import { readCurrentCanonicalIndexAuthority } from "./askCanonicalIndex.ts";
import type { BackfillAuthority } from "../mail/crmBackfillAuthority.ts";
import type {
  BackfillAllocation,
  BackfillAllocationVerifier,
} from "../mail/crmBackfillBudget.ts";
import type { SessionQueryable } from "../db/queryable.ts";
import {
  repositoryContext,
  workspaceScope,
  type RepositoryContext,
} from "../db/workspaceScope.ts";
import {
  verifyCurrentCrmCapability,
  verifyCrmCapabilityAuthority,
  crmCapabilityConfigurationFingerprint,
  type CrmCapabilityRuntime,
} from "./capabilityAuthority.ts";
import { askFingerprint } from "./askAnswerAuthority.ts";
import type { AskPurposeProofInput } from "./askAnswerPorts.ts";
import type {
  MailCaptureProof,
  MailCaptureProofVerifier,
} from "../mail/crmSources.ts";
export interface CrmExtractionAuthorityInput {
  workspaceId: string;
  generationId: string;
  requestedBy: string;
  sourceOwnerUserId: string;
  purposeRevision: number;
  processorVersion: string;
  contextHash: string;
  authorizationHash: string;
}
export interface CrmAuthoritySessions {
  openSession(): Promise<{ session: SessionQueryable; close(): Promise<void> }>;
  runtime: CrmCapabilityRuntime;
}
async function ownerContext(
  session: SessionQueryable,
  workspaceId: string,
  owner: string,
) {
  const member = (
    await session.query<{ role: "admin" | "salesperson"; status: string }>(
      "SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
      [workspaceId, owner],
    )
  ).rows[0];
  return member?.status === "active"
    ? repositoryContext(
        workspaceScope(workspaceId, {
          kind: "user",
          userId: owner,
          role: member.role,
        }),
        session,
      )
    : null;
}
async function sourceOwned(
  context: RepositoryContext,
  kind: string,
  id: string,
  owner: string,
) {
  const original = (
    await context.db.query<{ owner: string }>(
      "SELECT coalesce(source_owner_user_id,requested_by) AS owner FROM crm_extraction_generations WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3 ORDER BY observed_at,id LIMIT 1",
      [context.scope.workspaceId, kind, id],
    )
  ).rows[0];
  if (original && original.owner !== owner) return false;
  const query =
    kind === "selected_note"
      ? "SELECT owner_user_id AS owner FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2"
      : kind === "mail"
        ? "SELECT owner_user_id AS owner FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2"
        : kind === "call_transcript"
          ? "SELECT actor_user_id AS owner FROM call_sessions WHERE workspace_id=$1 AND id=$2"
          : kind === "meeting_transcript"
            ? "SELECT r.crm_capture_owner_user_id AS owner FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id WHERE t.workspace_id=$1 AND t.id=$2"
            : null;
  if (!query) return false;
  const row = (
    await context.db.query<{ owner: string | null }>(query, [
      context.scope.workspaceId,
      id,
    ])
  ).rows[0];
  return row !== undefined && row.owner === owner;
}
async function capture(
  context: RepositoryContext,
  proof: MailCaptureProof,
  runtime: CrmCapabilityRuntime,
) {
  const owned =
    context.scope.actor.kind === "user"
      ? context
      : await ownerContext(context.db, proof.workspaceId, proof.ownerUserId);
  if (owned === null) return false;
  context = owned;
  const receipt = await verifyCurrentCrmCapability(
    context,
    { capability: "mail_capture", mailboxId: proof.mailboxId },
    runtime,
  );
  const c = receipt?.configuration;
  if (!c || c.capability !== "mail_capture") return false;
  return (
    c.workspaceId === proof.workspaceId &&
    c.ownerUserId === proof.ownerUserId &&
    c.providerAccountId === proof.providerAccountId &&
    c.accountBinding === proof.accountBinding &&
    c.generation === proof.generation &&
    c.revision === proof.controlsRevision &&
    c.policyRevision === proof.policyRevision &&
    c.disclosureVersion === proof.disclosureVersion &&
    c.disclosureSha256 === proof.disclosureSha256 &&
    c.grantReceipt === proof.grantReceipt &&
    c.providerPolicyReceipt === proof.providerPolicyReceipt &&
    c.evaluationReceipt === proof.evaluationReceipt &&
    c.releaseReceipt === proof.releaseReceipt &&
    c.captureVersion === proof.captureVersion
  );
}
async function extraction(
  context: RepositoryContext,
  input: CrmExtractionAuthorityInput,
  runtime: CrmCapabilityRuntime,
) {
  if (
    context.scope.actor.kind !== "user" ||
    context.scope.actor.userId !== input.requestedBy ||
    input.requestedBy !== input.sourceOwnerUserId
  )
    return false;
  const row = (
    await context.db.query<Record<string, unknown>>(
      "SELECT * FROM crm_extraction_generations WHERE workspace_id=$1 AND id=$2",
      [input.workspaceId, input.generationId],
    )
  ).rows[0];
  if (
    !row ||
    row["requested_by"] !== input.requestedBy ||
    (row["source_owner_user_id"] ?? row["requested_by"]) !==
      input.sourceOwnerUserId ||
    row["purpose_revision"] !== input.purposeRevision ||
    row["processor_version"] !== input.processorVersion ||
    row["context_hash"] !== input.contextHash ||
    row["authorization_hash"] !== input.authorizationHash ||
    !(await sourceOwned(
      context,
      String(row["source_kind"]),
      String(row["source_id"]),
      input.requestedBy,
    ))
  )
    return false;
  const receipt = await verifyCurrentCrmCapability(
    context,
    { capability: "crm_extraction" },
    runtime,
  );
  return (
    receipt?.configuration.revision === input.purposeRevision &&
    receipt.configuration.capability === "crm_extraction" &&
    receipt.configuration.processorVersion === input.processorVersion
  );
}
async function answer(
  context: RepositoryContext,
  input: AskPurposeProofInput,
  runtime: CrmCapabilityRuntime,
) {
  if (
    (input.stage === "answer"
      ? input.purpose.purpose !== "answer"
      : ["embedding_query", "embedding_document"].includes(input.stage)
        ? input.purpose.purpose !== "embedding"
        : true) ||
    context.scope.actor.kind !== "user" ||
    context.scope.actor.userId !== input.ownerUserId
  )
    return null;
  const receipt = await verifyCurrentCrmCapability(
    context,
    {
      capability: "ask_answer",
      purpose: input.purpose.purpose === "embedding" ? "embedding" : "answer",
    },
    runtime,
  );
  if (!receipt || receipt.configuration.capability !== "ask_answer")
    return null;
  const c = receipt.configuration;
  const { capability: _, workspaceId: __, ownerUserId: ___, ...p } = c;
  void _;
  void __;
  void ___;
  if (
    input.workspaceId !== context.scope.workspaceId ||
    Object.entries(input.purpose).some(
      ([key, value]) =>
        askFingerprint(p[key as keyof typeof p]) !== askFingerprint(value),
    ) ||
    askFingerprint({ purpose: input.purpose, route: input.route }) !==
      input.configFingerprint
  )
    return null;
  let sources: readonly { kind: string; sourceId: string }[];
  if (input.target.kind === "canonical_index") {
    if (input.stage !== "embedding_document") return null;
    const current = await readCurrentCanonicalIndexAuthority(
      context,
      input.target,
      input.route,
    );
    if (!current || !isDeepStrictEqual(current.proofInput, input)) return null;
    sources = current.sources;
  } else {
    const row = (
      await context.db.query<{ state: string; cancelled_at: Date | null }>(
        "SELECT state,cancelled_at FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND version=$4 AND epoch=$5",
        [
          context.scope.workspaceId,
          input.target.requestId,
          input.ownerUserId,
          input.target.version,
          input.target.epoch,
        ],
      )
    ).rows[0];
    if (!row || row.state !== "pending" || row.cancelled_at !== null)
      return null;
    const evidence = await readAskExecutionEvidence(context, {
      requestId: input.target.requestId,
      version: input.target.version,
      epoch: input.target.epoch,
    });
    if (!evidence) return null;
    const originals = [];
    const mail = createNativeCrmMailEvidence();
    for (const source of evidence.scope.sources) {
      const original = await resolveCrmSource(context, source, mail);
      if (!original) return null;
      originals.push(original.source);
    }
    const attribution = await readAskConversationAttribution(
      context,
      originals,
    );
    if (attribution === null) return null;
    const evidenceFingerprint = evidence.fingerprint,
      attributionFingerprint = askFingerprint(attribution);
    const inputScopeFingerprint = askFingerprint(evidence.scope),
      contextFingerprint = askFingerprint(evidence.contexts),
      initialAccessFingerprint = askFingerprint(evidence.closure);
    if (
      input.inputScopeFingerprint !== inputScopeFingerprint ||
      input.contextFingerprint !== contextFingerprint ||
      input.initialAccessFingerprint !== initialAccessFingerprint ||
      input.evidenceFingerprint !== evidenceFingerprint ||
      input.attributionFingerprint !== attributionFingerprint ||
      !isDeepStrictEqual(input.agentScope, evidence.intent)
    )
      return null;
    if (
      askFingerprint({
        target: input.target,
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
        inputScopeFingerprint,
        contextFingerprint,
        initialAccessFingerprint,
        evidenceFingerprint,
        attributionFingerprint,
        agentScope: evidence.intent,
      }) !== input.authorizationFingerprint
    )
      return null;
    sources = evidence.scope.sources;
  }
  for (const source of sources)
    if (
      !(await sourceOwned(
        context,
        source.kind,
        source.sourceId,
        input.ownerUserId,
      ))
    )
      return null;
  return {
    configFingerprint: input.configFingerprint,
    authorizationFingerprint: input.authorizationFingerprint,
    validUntil: receipt.validUntil,
    evaluationKind: "actual" as const,
  };
}
/** Independent registry reads never mint grant from config. Network waits are outside these sessions. */
export function createCrmCapabilityVerifiers(deps: CrmAuthoritySessions) {
  async function outside<T>(
    workspaceId: string,
    owner: string,
    run: (context: RepositoryContext) => Promise<T>,
    fallback: T,
  ) {
    const opened = await deps.openSession();
    try {
      const context = await ownerContext(opened.session, workspaceId, owner);
      return context ? await run(context) : fallback;
    } catch {
      return fallback;
    } finally {
      await opened.close();
    }
  }
  async function backfill(
    context: RepositoryContext,
    allocation: BackfillAllocation,
    authority: BackfillAuthority,
  ) {
    if (
      !(await capture(context, authority.proof, deps.runtime)) ||
      allocation.workspace_id !== authority.proof.workspaceId ||
      allocation.mailbox_id !== authority.proof.mailboxId ||
      allocation.owner_user_id !== authority.proof.ownerUserId ||
      allocation.account_binding !== authority.proof.accountBinding ||
      allocation.generation !== authority.proof.generation ||
      allocation.verified_until.getTime() <= Date.now()
    )
      return false;
    const owned = await ownerContext(
      context.db,
      authority.proof.workspaceId,
      authority.proof.ownerUserId,
    );
    if (!owned) return false;
    const configuration = {
      capability: "mail_backfill" as const,
      workspaceId: authority.proof.workspaceId,
      ownerUserId: authority.proof.ownerUserId,
      revision: allocation.revision,
      mailboxId: authority.proof.mailboxId,
      providerAccountId: authority.proof.providerAccountId,
      generation: authority.proof.generation,
      accountBinding: authority.proof.accountBinding,
      scopeFingerprint: crmBackfillScopeFingerprint(authority),
      allocationFingerprint: crmBackfillAllocationFingerprint(allocation),
    };
    const rows = (
      await context.db.query<{ id: string }>(
        "SELECT id FROM crm_capability_authority_receipts WHERE workspace_id=$1 AND capability='mail_backfill' AND configuration_sha256=$2 AND revoked_at IS NULL AND valid_until>clock_timestamp() ORDER BY verified_at DESC",
        [
          authority.proof.workspaceId,
          crmCapabilityConfigurationFingerprint(configuration),
        ],
      )
    ).rows;
    for (const row of rows)
      if (
        await verifyCrmCapabilityAuthority(
          owned,
          configuration,
          row.id,
          deps.runtime,
        )
      )
        return true;
    return false;
  }
  const allocationVerifier: BackfillAllocationVerifier = {
    verify: (allocation, authority) =>
      authority
        ? outside(
            allocation.workspace_id,
            allocation.owner_user_id,
            (c) => backfill(c, allocation, authority),
            false,
          )
        : Promise.resolve(false),
    revalidate: backfill,
  };
  const revalidateMetadata = async (
    context: RepositoryContext,
    input: { mailboxId: string; ownerUserId: string },
  ) => {
    const owned = await ownerContext(
      context.db,
      context.scope.workspaceId,
      input.ownerUserId,
    );
    return (
      owned !== null &&
      (await verifyCurrentCrmCapability(
        owned,
        { capability: "metadata_review", mailboxId: input.mailboxId },
        deps.runtime,
      )) !== null
    );
  };
  const captureVerifier: MailCaptureProofVerifier = {
    verify: (proof) =>
      outside(
        proof.workspaceId,
        proof.ownerUserId,
        (c) => capture(c, proof, deps.runtime),
        false,
      ),
    revalidate: (context, proof) => capture(context, proof, deps.runtime),
  };
  return {
    captureVerifier,
    allocationVerifier,
    revalidateMetadata,
    verifyExtraction: (input: CrmExtractionAuthorityInput) =>
      outside(
        input.workspaceId,
        input.requestedBy,
        (c) => extraction(c, input, deps.runtime),
        false,
      ),
    revalidateExtraction: (
      context: RepositoryContext,
      input: CrmExtractionAuthorityInput,
    ) => extraction(context, input, deps.runtime),
    verifyAskPurpose: (input: AskPurposeProofInput) =>
      outside(
        input.workspaceId,
        input.ownerUserId,
        (c) => answer(c, input, deps.runtime),
        null,
      ),
    revalidateAskPurpose: async (
      context: RepositoryContext,
      input: AskPurposeProofInput,
    ) => (await answer(context, input, deps.runtime)) !== null,
  };
}

/** Frozen import/allocation digests contain no message bodies or provider cursor. */
export function crmBackfillScopeFingerprint(authority: BackfillAuthority) {
  return askFingerprint({
    olderContextVersion: "bounded-qualified-thread-v1",
    maxThreadMessages: 500,
    importId: authority.importId,
    proof: authority.proof,
    fromEpochMicroseconds: authority.fromEpochMicroseconds,
    toEpochMicroseconds: authority.toEpochMicroseconds,
  });
}
export function crmBackfillAllocationFingerprint(
  allocation: BackfillAllocation,
) {
  return askFingerprint({
    mailboxId: allocation.mailbox_id,
    revision: allocation.revision,
    ownerUserId: allocation.owner_user_id,
    accountBinding: allocation.account_binding,
    generation: allocation.generation,
    projectHash: allocation.project_hash,
    userHash: allocation.user_hash,
    userLimitUnits: allocation.user_limit_units,
    projectLimitUnits: allocation.project_limit_units,
    userHeadroomUnits: allocation.user_headroom_units,
    projectHeadroomUnits: allocation.project_headroom_units,
    profileUnits: allocation.profile_units,
    listUnits: allocation.list_units,
    historyUnits: allocation.history_units,
    metadataUnits: allocation.metadata_units,
    bodyUnits: allocation.body_units,
    threadUnits: allocation.thread_units,
    verificationSha256: allocation.verification_sha256,
    verifiedUntil: allocation.verified_until.toISOString(),
  });
}
