import { CRM_DIAGNOSTIC_QUOTA_SCHEDULE } from "@fss/contracts";
import { repositoryContext, workspaceScope } from "../db/workspaceScope.ts";
import { withTransaction, type SessionQueryable } from "../db/queryable.ts";
import {
  prepareCrmAcquisitionDiagnosticIsolation,
  verifyCrmAcquisitionDiagnostic,
  type DiagnosticIsolationProof,
  type CrmAcquisitionDiagnosticRuntime,
} from "./crmAcquisitionDiagnostic.ts";
import { createGmailMailCaptureProvider } from "./crmGmailProvider.ts";
import {
  MAIL_CAPTURE_VERSION,
  type CapturePayload,
  type CaptureAuthority,
  type MailCaptureProof,
  type MailCaptureProofVerifier,
  type businessMailCaptureHandler,
} from "./crmSources.ts";
import type { GmailClient } from "./gmailClient.ts";
import type { JobHandlerInput } from "../jobs/handlerRegistry.ts";
type CaptureComposition = NonNullable<
  Parameters<typeof businessMailCaptureHandler>[0]["diagnostic"]
>;
export function createCrmAcquisitionDiagnosticCapture(input: {
  runtime: CrmAcquisitionDiagnosticRuntime;
  transport: "controlled" | "actual_transport";
  gmail: GmailClient;
  openSession(): Promise<{ session: SessionQueryable; close(): Promise<void> }>;
  resolveAccess: Parameters<
    typeof createGmailMailCaptureProvider
  >[0]["resolveAccess"];
}): CaptureComposition {
  async function withContext<T>(
    proof: MailCaptureProof,
    work: (session: SessionQueryable) => Promise<T>,
  ) {
    const opened = await input.openSession();
    try {
      return await work(opened.session);
    } finally {
      await opened.close();
    }
  }
  function id(proof: MailCaptureProof) {
    return proof.grantReceipt;
  }
  const isolation = new Map<string, DiagnosticIsolationProof>();
  async function verified(proof: MailCaptureProof, session: SessionQueryable) {
    const context = repositoryContext(
      workspaceScope(proof.workspaceId, {
        kind: "system",
        component: "worker",
      }),
      session,
    );
    const a = await verifyCrmAcquisitionDiagnostic(
      context,
      id(proof),
      input.runtime,
      true,
      isolation.get(id(proof)),
    );
    return a &&
      a.ownerUserId === proof.ownerUserId &&
      a.mailboxId === proof.mailboxId &&
      a.providerAccountId === proof.providerAccountId &&
      a.generation === proof.generation &&
      a.accountBinding === proof.accountBinding &&
      a.consentReference === proof.evaluationReceipt
      ? a
      : null;
  }
  const verifier: MailCaptureProofVerifier = {
    verify: (proof) =>
      withContext(proof, async (session) => {
        const context = repositoryContext(
          workspaceScope(proof.workspaceId, {
            kind: "system",
            component: "worker",
          }),
          session,
        );
        const witness = await prepareCrmAcquisitionDiagnosticIsolation(
          context,
          { authorizationId: id(proof) },
          input.runtime,
        );
        if (!witness) return false;
        isolation.set(id(proof), witness);
        return withTransaction(
          session,
          async () => (await verified(proof, session)) !== null,
        );
      }),
    revalidate: async (context, proof) =>
      (await verified(proof, context.db)) !== null,
  };
  async function lockAuthority(
    job: JobHandlerInput,
    payload: CapturePayload,
  ): Promise<CaptureAuthority | null> {
    if (
      !payload.diagnosticAuthorizationId ||
      job.scope.actor.kind !== "system" ||
      job.scope.actor.component !== "worker"
    )
      return null;
    const lease = await job.session.query(
      "SELECT 1 FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",
      [
        job.scope.workspaceId,
        job.job.id,
        job.job.leaseOwner,
        job.job.fencingToken,
      ],
    );
    if (!lease.rows.length) return null;
    const context = repositoryContext(job.scope, job.session);
    const a = await verifyCrmAcquisitionDiagnostic(
      context,
      payload.diagnosticAuthorizationId,
      input.runtime,
      false,
    );
    const m = a?.messages.find(
      (m) => m.messageId === payload.providerMessageId,
    );
    if (
      !a ||
      !m ||
      payload.mailboxId !== a.mailboxId ||
      payload.providerAccountId !== a.providerAccountId ||
      payload.generation !== a.generation
    )
      return null;
    const mailbox = (
      await job.session.query<{ email_address: string }>(
        "SELECT email_address FROM mailboxes WHERE workspace_id=$1 AND id=$2",
        [a.workspaceId, a.mailboxId],
      )
    ).rows[0]!;
    return {
      mailboxEmail: mailbox.email_address,
      conversation: {
        id: a.id,
        owner_user_id: a.ownerUserId,
        account_binding: a.accountBinding,
        provider_thread_id: m.threadId,
        metadata_availability: "available",
        category: "diagnostic_scope",
        human_decision: "include",
        decision_revision: 0,
      },
      proof: {
        workspaceId: a.workspaceId,
        mailboxId: a.mailboxId,
        ownerUserId: a.ownerUserId,
        providerAccountId: a.providerAccountId,
        accountBinding: a.accountBinding,
        generation: a.generation,
        controlsRevision: 1,
        policyRevision: 1,
        disclosureVersion: a.disclosureVersion,
        disclosureSha256: a.disclosureSha256,
        grantReceipt: a.id,
        providerPolicyReceipt: a.providerPolicyReference,
        evaluationReceipt: a.consentReference,
        releaseReceipt: a.releaseReference,
        captureVersion: MAIL_CAPTURE_VERSION,
      },
    };
  }
  const provider = {
    async read(
      request: Parameters<
        ReturnType<typeof createGmailMailCaptureProvider>["read"]
      >[0],
    ) {
      const candidate = request.expectedProof;
      if (!candidate) throw new Error("diagnostic_authority_unavailable");
      const proof = candidate;
      async function call<T>(
        operation: "profile_before" | "metadata" | "body" | "profile_after",
        dispatch: () => Promise<T>,
      ): Promise<T> {
        const reserved = await withContext(proof, async (session) =>
          withTransaction(session, async () => {
            const a = await verified(proof, session);
            if (
              !a ||
              !a.messages.some((m) => m.messageId === request.providerMessageId)
            )
              return false;
            await session.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
              [`crm-diagnostic-budget:${a.workspaceId}:${a.id}`],
            );
            const usage = (
              await session.query<{ reads: number; units: number }>(
                "SELECT count(*)::int AS reads,COALESCE(sum(units),0)::int AS units FROM crm_acquisition_diagnostic_reads WHERE workspace_id=$1 AND authorization_id=$2",
                [a.workspaceId, a.id],
              )
            ).rows[0]!;
            const units = operation.startsWith("profile")
              ? CRM_DIAGNOSTIC_QUOTA_SCHEDULE.profile
              : CRM_DIAGNOSTIC_QUOTA_SCHEDULE.metadata;
            if (usage.reads >= a.maxReads || usage.units + units > a.maxUnits)
              return false;
            const row = await session.query(
              "INSERT INTO crm_acquisition_diagnostic_reads(workspace_id,authorization_id,message_id,operation,transport,state,units,quota_schedule_version) VALUES($1,$2,$3,$4,$5,'calling',$6,'gmail-2026-05-01') ON CONFLICT DO NOTHING RETURNING message_id",
              [
                a.workspaceId,
                a.id,
                request.providerMessageId,
                operation,
                input.transport,
                units,
              ],
            );
            return row.rows.length === 1;
          }),
        );
        if (!reserved) throw new Error("diagnostic_read_unavailable");
        let value: T;
        try {
          value = await dispatch();
        } catch {
          await withContext(proof, (session) =>
            session.query(
              "UPDATE crm_acquisition_diagnostic_reads SET state='unknown' WHERE workspace_id=$1 AND authorization_id=$2 AND message_id=$3 AND operation=$4 AND state='calling'",
              [
                proof.workspaceId,
                id(proof),
                request.providerMessageId,
                operation,
              ],
            ),
          );
          throw new Error("diagnostic_read_unknown");
        }
        await withContext(proof, (session) =>
          session.query(
            "UPDATE crm_acquisition_diagnostic_reads SET state='observed' WHERE workspace_id=$1 AND authorization_id=$2 AND message_id=$3 AND operation=$4 AND state='calling'",
            [
              proof.workspaceId,
              id(proof),
              request.providerMessageId,
              operation,
            ],
          ),
        );
        return value;
      }
      let phase = 0;
      const wrapped = {
        ...input.gmail,
        getMetadata: async (
          ...args: Parameters<GmailClient["getMetadata"]>
        ) => {
          const metadata = await call("metadata", () =>
            input.gmail.getMetadata(...args),
          );
          if (!metadata) throw new Error("diagnostic_metadata_unavailable");
          const a = await withContext(proof, (session) =>
            verified(proof, session),
          );
          const m = a?.messages.find(
            (m) => m.messageId === request.providerMessageId,
          );
          const actual = metadata.labelIds.includes("DRAFT")
            ? "unknown"
            : metadata.labelIds.includes("SENT")
              ? "sent"
              : metadata.labelIds.includes("INBOX")
                ? "received"
                : "unknown";
          if (
            !m ||
            metadata.id !== m.messageId ||
            metadata.threadId !== m.threadId ||
            actual !== m.origin ||
            !Number.isFinite(metadata.internalDateEpochMilliseconds) ||
            metadata.internalDateEpochMilliseconds < Date.parse(m.fromAt) ||
            metadata.internalDateEpochMilliseconds > Date.parse(m.toAt)
          )
            throw new Error("diagnostic_metadata_out_of_scope");
          return metadata;
        },
        getBody: (...args: Parameters<GmailClient["getBody"]>) =>
          call("body", () => input.gmail.getBody(...args)),
      };
      const resolveAccess: typeof input.resolveAccess = async (request) => {
        if (!(await verifier.verify(proof))) return null;
        const access = await input.resolveAccess(request);
        if (!access) return null;
        const profile = await call(
          phase++ === 0 ? "profile_before" : "profile_after",
          () => input.gmail.getProfile(access.access),
        );
        if (
          profile.emailAddress.toLowerCase() !==
            proof.providerAccountId.toLowerCase() ||
          !(await verifier.verify(proof))
        )
          return null;
        return access;
      };
      return createGmailMailCaptureProvider({
        gmail: wrapped,
        resolveAccess,
        authorizeRead: verifier.verify,
      }).read(request);
    },
  };
  return { provider, proofVerifier: verifier, lockAuthority };
}
