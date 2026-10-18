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
  crmCapabilityConfigurationFingerprint,
  type CrmCapabilityRuntime,
} from "./capabilityAuthority.ts";
import { createHash } from "node:crypto";
import {sameForwardCaptureScope} from '../mail/crmForwardCaptureScope.ts';
import {mailExtractionScopeAllows} from './processingScope.ts';
import type {
  MailCaptureProof,
  MailCaptureProofVerifier,
} from "../mail/crmSources.ts";
const allocationFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  if (!c || c.capability !== "mail_capture"||!c.forwardScope||!proof.forwardScope||!sameForwardCaptureScope(c.forwardScope,proof.forwardScope)) return false;
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
    receipt.ownerApprovalId === proof.ownerApprovalId &&
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
  if(!await mailExtractionScopeAllows(context,{kind:String(row['source_kind']),sourceId:String(row['source_id'])}))return false;
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
    const rows = (await context.db.query<{id:string}>(`SELECT a.id FROM crm_mail_imports i JOIN crm_capability_owner_approvals a ON a.workspace_id=i.workspace_id AND a.id=i.owner_approval_id WHERE i.workspace_id=$1 AND i.id=$2 AND a.owner_user_id=$3 AND a.capability='mail_backfill' AND a.configuration_sha256=$4`,[authority.proof.workspaceId,authority.importId,authority.proof.ownerUserId,crmCapabilityConfigurationFingerprint(configuration)])).rows;
    return rows.length===1;
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
  };
}

/** Frozen import/allocation digests contain no message bodies or provider cursor. */
export function crmBackfillScopeFingerprint(authority: BackfillAuthority) {
  return allocationFingerprint({
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
  return allocationFingerprint({
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
