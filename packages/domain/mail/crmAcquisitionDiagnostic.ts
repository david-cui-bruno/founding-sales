import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import {
  crmAcquisitionDiagnosticAuthorizationSchema,
  type CrmAcquisitionDiagnosticAuthorization,
} from "@fss/contracts";
import { withTransaction, type SessionQueryable } from "../db/queryable.ts";
import {
  repositoryContext,
  workspaceScope,
  type RepositoryContext,
} from "../db/workspaceScope.ts";
import { businessAccountBinding } from "../business/acquisition.ts";
import { CRM_MAIL_CAPTURE_DISCLOSURE } from "../crm/capabilityAuthority.ts";
import { enqueueJob } from "../jobs/jobStore.ts";
const legacyAuthorizationSchema = z
  .strictObject({
    ...crmAcquisitionDiagnosticAuthorizationSchema.shape,
    schemaVersion: z.literal(89),
    metadataUnits: z.literal(5),
    bodyUnits: z.literal(5),
    maxUnits: z.number().int().min(1).max(10000),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.validUntil) <= Date.parse(value.verifiedAt))
      context.addIssue({ code: "custom", message: "invalid expiry" });
    if (
      new Set(value.messages.map((message) => message.messageId)).size !==
      value.messages.length
    )
      context.addIssue({ code: "custom", message: "duplicate message" });
    if (
      value.messages.some(
        (message) => Date.parse(message.fromAt) > Date.parse(message.toAt),
      )
    )
      context.addIssue({ code: "custom", message: "invalid scope" });
  });
const diagnosticDocumentSchema = z.union([
  crmAcquisitionDiagnosticAuthorizationSchema,
  legacyAuthorizationSchema,
]);
type DiagnosticDocument = z.infer<typeof diagnosticDocumentSchema>;
type IsolationPurpose =
  | "acquisition_dispatch"
  | "progress_read"
  | "oauth_bootstrap";
function documentFingerprint(input: DiagnosticDocument) {
  return createHash("sha256")
    .update(JSON.stringify(diagnosticDocumentSchema.parse(input)))
    .digest("hex");
}
export interface CrmAcquisitionDiagnosticRuntime {
  environmentId: string;
  implementationCommit: string;
  imageDigest: string;
  side: "api" | "worker";
  schemaVersion: 90;
  consentIsolationBinding?: {
    databaseInstanceArn: string;
    databaseSecretArn: string;
    databaseEndpoint: string;
    ecsClusterArn: string;
  };
  verifyIsolation(input: {
    environmentId: string;
    databaseName: string;
    deploymentIdentity: string;
    databaseInstanceArn: string;
    databaseSecretArn: string;
    databaseEndpoint: string;
    ecsClusterArn: string;
    connectedServerAddress: string | null;
    purpose?: IsolationPurpose;
  }): Promise<boolean>;
}
export interface DiagnosticIsolationProof {
  readonly authorizationId: string;
  readonly authorizationSha256: string;
}
const isolationProofs = new WeakMap<
  DiagnosticIsolationProof,
  {
    runtime: CrmAcquisitionDiagnosticRuntime;
    validUntil: number;
    serverAddress: string | null;
    databaseName: string;
    purpose: IsolationPurpose;
  }
>();
function isolationCurrent(
  proof: DiagnosticIsolationProof | undefined,
  a: DiagnosticDocument,
  runtime: CrmAcquisitionDiagnosticRuntime,
  connection: { name: string; address: string | null } | undefined,
  purpose: IsolationPurpose = "acquisition_dispatch",
) {
  const current = proof ? isolationProofs.get(proof) : undefined;
  return (
    current?.runtime === runtime &&
    current.purpose === purpose &&
    current.validUntil > Date.now() &&
    current.serverAddress === connection?.address &&
    current.databaseName === connection?.name &&
    proof?.authorizationId === a.id &&
    proof.authorizationSha256 === documentFingerprint(a)
  );
}
export async function prepareCrmAcquisitionDiagnosticIsolation(
  context: RepositoryContext,
  input: { authorizationId: string },
  runtime?: CrmAcquisitionDiagnosticRuntime,
  purpose: IsolationPurpose = "acquisition_dispatch",
): Promise<DiagnosticIsolationProof | null> {
  if (!runtime) return null;
  const row = (
    await context.db.query<{
      authorization: unknown;
      authorization_sha256: string;
    }>(
      "SELECT authorization_document AS authorization,authorization_sha256 FROM crm_acquisition_diagnostic_authorizations WHERE workspace_id=$1 AND id=$2",
      [context.scope.workspaceId, input.authorizationId],
    )
  ).rows[0];
  const parsed = diagnosticDocumentSchema.safeParse(row?.authorization);
  if (!parsed.success) return null;
  const a = parsed.data;
  const legacyAudit = purpose === "progress_read" && a.schemaVersion === 89;
  const actor = context.scope.actor;
  if (
    (actor.kind === "user" && actor.userId !== a.ownerUserId) ||
    (actor.kind === "system" && actor.component !== "worker")
  )
    return null;
  if (
    row?.authorization_sha256 !== documentFingerprint(a) ||
    a.environmentId !== runtime.environmentId ||
    (!legacyAudit &&
      (a.implementationCommit !== runtime.implementationCommit ||
        a.schemaVersion !== runtime.schemaVersion ||
        (runtime.side === "api" ? a.apiImageDigest : a.workerImageDigest) !==
          runtime.imageDigest))
  )
    return null;
  const db = (
    await context.db.query<{ name: string; address: string | null }>(
      "SELECT current_database() AS name,inet_server_addr()::text AS address",
    )
  ).rows[0];
  if (db?.name !== a.databaseName) return null;
  try {
    if (
      !(await runtime.verifyIsolation({
        environmentId: a.environmentId,
        databaseName: a.databaseName,
        deploymentIdentity:
          runtime.side === "api"
            ? a.deploymentIdentity
            : a.workerDeploymentIdentity,
        databaseInstanceArn: a.databaseInstanceArn,
        databaseSecretArn: a.databaseSecretArn,
        databaseEndpoint: a.databaseEndpoint,
        ecsClusterArn: a.ecsClusterArn,
        connectedServerAddress: db.address,
        purpose,
      }))
    )
      return null;
  } catch {
    return null;
  }
  const proof = Object.freeze({
    authorizationId: a.id,
    authorizationSha256: documentFingerprint(a),
  });
  isolationProofs.set(proof, {
    runtime,
    validUntil: Date.now() + 30000,
    serverAddress: db.address,
    databaseName: db.name,
    purpose,
  });
  return proof;
}
export function crmAcquisitionDiagnosticFingerprint(
  input: CrmAcquisitionDiagnosticAuthorization,
) {
  return createHash("sha256")
    .update(
      JSON.stringify(crmAcquisitionDiagnosticAuthorizationSchema.parse(input)),
    )
    .digest("hex");
}
async function lock(context: RepositoryContext, id: string, exclusive = false) {
  await context.db.query(
    `SELECT pg_advisory_xact_lock${exclusive ? "" : "_shared"}(hashtextextended($1,0))`,
    [`crm-diagnostic:${context.scope.workspaceId}:${id}`],
  );
}
export async function verifyCrmAcquisitionDiagnostic(
  context: RepositoryContext,
  id: string,
  runtime?: CrmAcquisitionDiagnosticRuntime,
  checkIsolation = true,
  isolationProof?: DiagnosticIsolationProof,
) {
  if (!runtime) return null;
  await lock(context, id);
  const row = (
    await context.db.query<{
      authorization: unknown;
      authorization_sha256: string;
    }>(
      `SELECT authorization_document AS authorization,authorization_sha256 FROM crm_acquisition_diagnostic_authorizations WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL AND verified_at<=clock_timestamp() AND valid_until>clock_timestamp()`,
      [context.scope.workspaceId, id],
    )
  ).rows[0];
  const parsed = crmAcquisitionDiagnosticAuthorizationSchema.safeParse(
    row?.authorization,
  );
  if (!parsed.success) return null;
  const a = parsed.data;
  if (
    row?.authorization_sha256 !== crmAcquisitionDiagnosticFingerprint(a) ||
    a.environmentId !== runtime.environmentId ||
    a.implementationCommit !== runtime.implementationCommit ||
    a.schemaVersion !== runtime.schemaVersion ||
    (runtime.side === "api" ? a.apiImageDigest : a.workerImageDigest) !==
      runtime.imageDigest ||
    a.disclosureVersion !== CRM_MAIL_CAPTURE_DISCLOSURE.version ||
    a.disclosureSha256 !== CRM_MAIL_CAPTURE_DISCLOSURE.sha256
  )
    return null;
  const databaseRow = (
    await context.db.query<{ name: string; address: string | null }>(
      "SELECT current_database() AS name,inet_server_addr()::text AS address",
    )
  ).rows[0];
  if (databaseRow?.name !== a.databaseName) return null;
  if (
    checkIsolation &&
    !isolationCurrent(isolationProof, a, runtime, databaseRow)
  )
    return null;
  const mailbox = (
    await context.db.query<{
      id: string;
      owner_user_id: string;
      email_address: string;
      provider_account_id: string;
      generation: number;
      status: string;
    }>(
      "SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE",
      [a.workspaceId, a.mailboxId],
    )
  ).rows[0];
  if (
    !mailbox ||
    mailbox.status !== "connected" ||
    mailbox.owner_user_id !== a.ownerUserId ||
    mailbox.provider_account_id !== a.providerAccountId ||
    mailbox.generation !== a.generation ||
    businessAccountBinding(a.workspaceId, mailbox) !== a.accountBinding
  )
    return null;
  const membership = await context.db.query(
    "SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",
    [a.workspaceId, a.ownerUserId],
  );
  if (!membership.rows.length) return null;
  const oauth = (
    await context.db.query<{ granted_scopes: string[] }>(
      "SELECT granted_scopes FROM mailbox_oauth_grant_observations WHERE workspace_id=$1 AND id=$2 AND mailbox_id=$3 AND owner_user_id=$4 AND provider_account_id=$5 AND generation=$6",
      [
        a.workspaceId,
        a.oauthGrantObservationId,
        a.mailboxId,
        a.ownerUserId,
        a.providerAccountId,
        a.generation,
      ],
    )
  ).rows[0];
  if (
    !oauth ||
    !oauth.granted_scopes.includes(
      "https://www.googleapis.com/auth/gmail.readonly",
    )
  )
    return null;
  const release = (
    await context.db.query<{ record: Record<string, unknown> }>(
      "SELECT record FROM release_records WHERE reference=$1 AND api_digest=$2 AND worker_digest=$3 AND desktop_commit_stamp=$4",
      [
        a.releaseReference,
        a.apiImageDigest,
        a.workerImageDigest,
        a.implementationCommit,
      ],
    )
  ).rows[0];
  if (release?.record["source"] !== "ci-gate") return null;
  return a;
}
export async function requestCrmAcquisitionDiagnostic(
  context: RepositoryContext,
  input: { authorizationId: string; expectedAuthorizationSha256: string },
  runtime?: CrmAcquisitionDiagnosticRuntime,
  isolationProof?: DiagnosticIsolationProof,
) {
  if (!runtime) return { ok: false as const, reason: "diagnostic_unavailable" };
  const actor = context.scope.actor;
  if (actor.kind !== "user" || actor.role !== "admin")
    return { ok: false as const, reason: "diagnostic_owner_required" };
  const a = await verifyCrmAcquisitionDiagnostic(
    context,
    input.authorizationId,
    runtime,
    true,
    isolationProof,
  );
  if (
    !a ||
    a.ownerUserId !== actor.userId ||
    crmAcquisitionDiagnosticFingerprint(a) !== input.expectedAuthorizationSha256
  )
    return { ok: false as const, reason: "diagnostic_authority_unavailable" };
  for (const message of a.messages) {
    const queued = await enqueueJob(context.db, {
      workspaceId: a.workspaceId,
      kind: "crm.mail_capture",
      idempotencyKey: `crm-diagnostic:${a.id}:${message.messageId}`,
      payload: {
        mailboxId: a.mailboxId,
        providerMessageId: message.messageId,
        providerAccountId: a.providerAccountId,
        generation: a.generation,
        conversationId: a.id,
        controlsRevision: 1,
        policyRevision: 1,
        decisionRevision: 0,
        diagnosticAuthorizationId: a.id,
      },
    });
    if (queued.inserted) {
      const sourceId = randomUUID();
      const identity = (
        await context.db.query<{ id: string }>(
          "INSERT INTO crm_mail_capture_identities(workspace_id,mailbox_id,account_binding,provider_message_id,lease_fencing_token,job_id,state,source_id) VALUES($1,$2,$3,$4,1,$5,'pending',$6) ON CONFLICT DO NOTHING RETURNING id",
          [
            a.workspaceId,
            a.mailboxId,
            a.accountBinding,
            message.messageId,
            queued.jobId,
            sourceId,
          ],
        )
      ).rows[0];
      if (!identity) throw new Error("diagnostic_source_conflict");
      await context.db.query(
        "INSERT INTO crm_mail_sources(workspace_id,source_id,capture_identity_id,source_revision,content_hash,owner_user_id,mailbox_id,provider_account_id,account_binding,acquired_generation,controls_revision,policy_revision,conversation_id,decision_revision,disclosure_version,disclosure_sha256,verification_receipts,parser_version,representation,completeness,passage_ranges,participants,provider_at,observed_at,availability,diagnostic_authorization_id) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,1,1,NULL,0,$10,$11,$12::jsonb,'diagnostic-pending','plain_text','unavailable','[]','[]',NULL,NULL,'awaiting_recapture',$13)",
        [
          a.workspaceId,
          sourceId,
          identity.id,
          "0".repeat(64),
          a.ownerUserId,
          a.mailboxId,
          a.providerAccountId,
          a.accountBinding,
          a.generation,
          a.disclosureVersion,
          a.disclosureSha256,
          JSON.stringify({ diagnostic: a.id }),
          a.id,
        ],
      );
    }
  }
  return {
    ok: true as const,
    value: {
      authorizationId: a.id,
      status: "queued" as const,
      productionActivationAllowed: false as const,
    },
  };
}
export async function readCrmAcquisitionDiagnostic(
  context: RepositoryContext,
  input: { authorizationId: string },
  runtime?: CrmAcquisitionDiagnosticRuntime,
  isolationProof?: DiagnosticIsolationProof,
) {
  if (!runtime || context.scope.actor.kind !== "user") return null;
  const row = (
    await context.db.query<{ authorization: unknown }>(
      "SELECT authorization_document AS authorization FROM crm_acquisition_diagnostic_authorizations WHERE workspace_id=$1 AND id=$2",
      [context.scope.workspaceId, input.authorizationId],
    )
  ).rows[0];
  const parsed = diagnosticDocumentSchema.safeParse(row?.authorization);
  if (!parsed.success || parsed.data.ownerUserId !== context.scope.actor.userId)
    return null;
  const a = parsed.data;
  const dbrow = (
    await context.db.query<{ name: string; address: string | null }>(
      "SELECT current_database() AS name,inet_server_addr()::text AS address",
    )
  ).rows[0];
  if (
    a.environmentId !== runtime.environmentId ||
    a.databaseName !== dbrow?.name ||
    (a.schemaVersion !== 89 &&
      (a.implementationCommit !== runtime.implementationCommit ||
        a.schemaVersion !== runtime.schemaVersion ||
        (runtime.side === "api" ? a.apiImageDigest : a.workerImageDigest) !==
          runtime.imageDigest))
  )
    return null;
  if (!isolationCurrent(isolationProof, a, runtime, dbrow, "progress_read"))
    return null;
  const active = await context.db.query(
    "SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active'",
    [context.scope.workspaceId, context.scope.actor.userId],
  );
  if (!active.rows.length) return null;
  const usage = (
    await context.db.query<{
      attempted: number;
      observed: number;
      conserved: number;
    }>(
      "SELECT count(*)::int AS attempted,COALESCE(sum(units) FILTER(WHERE state='observed'),0)::int AS observed,COALESCE(sum(units) FILTER(WHERE state IN ('calling','unknown')),0)::int AS conserved FROM crm_acquisition_diagnostic_reads WHERE workspace_id=$1 AND authorization_id=$2",
      [context.scope.workspaceId, input.authorizationId],
    )
  ).rows[0]!;
  const copies = (
    await context.db.query<{
      sourceId: string;
      sourceRevision: number;
      availability: "available" | "deleted" | "awaiting_recapture";
    }>(
      'SELECT source_id AS "sourceId",source_revision AS "sourceRevision",availability FROM crm_mail_sources WHERE workspace_id=$1 AND diagnostic_authorization_id=$2 ORDER BY source_id',
      [context.scope.workspaceId, input.authorizationId],
    )
  ).rows;
  const modes = (
    await context.db.query<{ transport: "controlled" | "actual_transport" }>(
      "SELECT DISTINCT transport FROM crm_acquisition_diagnostic_reads WHERE workspace_id=$1 AND authorization_id=$2",
      [context.scope.workspaceId, input.authorizationId],
    )
  ).rows;
  const outcomes = (
    await context.db.query<{ outcome: string }>(
      "SELECT COALESCE(payload->'progress'->>'outcome',state) AS outcome FROM jobs WHERE workspace_id=$1 AND payload->>'diagnosticAuthorizationId'=$2 ORDER BY id",
      [context.scope.workspaceId, input.authorizationId],
    )
  ).rows.map((row) => row.outcome);
  const accountingBuckets = (
    await context.db.query<{
      scheduleVersion: "gmail-2026-05-01" | "legacy-v89-recorded-unverified";
      attemptedReads: number;
      observedUnits: number;
      conservedUnits: number;
    }>(
      `SELECT quota_schedule_version AS "scheduleVersion",count(*)::int AS "attemptedReads",COALESCE(sum(units) FILTER(WHERE state='observed'),0)::int AS "observedUnits",COALESCE(sum(units) FILTER(WHERE state IN ('calling','unknown')),0)::int AS "conservedUnits" FROM crm_acquisition_diagnostic_reads WHERE workspace_id=$1 AND authorization_id=$2 GROUP BY quota_schedule_version ORDER BY quota_schedule_version`,
      [context.scope.workspaceId, input.authorizationId],
    )
  ).rows;
  const accountingProvenance =
    accountingBuckets.length === 0
      ? ("not_started" as const)
      : accountingBuckets.length > 1
        ? ("mixed" as const)
        : accountingBuckets[0]!.scheduleVersion === "gmail-2026-05-01"
          ? ("documented_current_schedule" as const)
          : ("legacy_recorded_unverified" as const);
  return {
    authorizationId: input.authorizationId,
    purpose: "acquisition_acceptance" as const,
    transport:
      modes.length === 0
        ? ("not_started" as const)
        : modes.length === 1
          ? modes[0]!.transport
          : ("mixed" as const),
    authorizationSha256: documentFingerprint(parsed.data),
    releaseReference: parsed.data.releaseReference,
    coverage: "explicit_scoped_partial" as const,
    outcomes,
    authorizedMessages: parsed.data.messages.length,
    attemptedReads: usage.attempted,
    observedUnits: usage.observed,
    conservedUnits: usage.conserved,
    releasedUnits: 0,
    accountingProvenance,
    accountingBuckets,
    copies,
    productionActivationAllowed: false as const,
  };
}
export async function provisionCrmAcquisitionDiagnostic(
  session: SessionQueryable,
  input: CrmAcquisitionDiagnosticAuthorization,
) {
  const trusted =
    (
      await session.query<{ allowed: boolean }>(
        "SELECT pg_has_role(current_user,'migration','MEMBER') AS allowed",
      )
    ).rows[0]?.allowed === true;
  if (!trusted)
    return { ok: false as const, reason: "trusted_operations_required" };
  const parsed = crmAcquisitionDiagnosticAuthorizationSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false as const, reason: "diagnostic_invalid" };
  const a = parsed.data;
  const digest = crmAcquisitionDiagnosticFingerprint(a);
  return withTransaction(session, async () => {
    const context = repositoryContext(
      workspaceScope(a.workspaceId, { kind: "system", component: "worker" }),
      session,
    );
    await lock(context, a.id, true);
    const database = (
      await session.query<{ name: string; address: string | null }>(
        "SELECT current_database() AS name,inet_server_addr()::text AS address",
      )
    ).rows[0]?.name;
    if (database !== a.databaseName)
      return { ok: false as const, reason: "diagnostic_environment_mismatch" };
    const reviewer = await session.query(
      "SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin'",
      [a.workspaceId, a.reviewedBy],
    );
    if (
      !reviewer.rows.length ||
      a.disclosureVersion !== CRM_MAIL_CAPTURE_DISCLOSURE.version ||
      a.disclosureSha256 !== CRM_MAIL_CAPTURE_DISCLOSURE.sha256
    )
      return { ok: false as const, reason: "diagnostic_invalid" };
    const existing = (
      await session.query<{ authorization_sha256: string }>(
        "SELECT authorization_sha256 FROM crm_acquisition_diagnostic_authorizations WHERE workspace_id=$1 AND id=$2",
        [a.workspaceId, a.id],
      )
    ).rows[0];
    if (existing)
      return existing.authorization_sha256 === digest
        ? {
            ok: true as const,
            value: { authorizationId: a.id, sha256: digest },
          }
        : { ok: false as const, reason: "diagnostic_conflict" };
    await session.query(
      "INSERT INTO crm_acquisition_diagnostic_authorizations(workspace_id,id,owner_user_id,mailbox_id,authorization_sha256,authorization_document,verified_at,valid_until) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
      [
        a.workspaceId,
        a.id,
        a.ownerUserId,
        a.mailboxId,
        digest,
        JSON.stringify(a),
        a.verifiedAt,
        a.validUntil,
      ],
    );
    return {
      ok: true as const,
      value: { authorizationId: a.id, sha256: digest },
    };
  });
}
export async function revokeCrmAcquisitionDiagnostic(
  session: SessionQueryable,
  input: { workspaceId: string; authorizationId: string; reference: string },
) {
  const trusted =
    (
      await session.query<{ allowed: boolean }>(
        "SELECT pg_has_role(current_user,'migration','MEMBER') AS allowed",
      )
    ).rows[0]?.allowed === true;
  if (!trusted)
    return { ok: false as const, reason: "trusted_operations_required" };
  if (input.reference.length < 1 || input.reference.length > 200)
    return { ok: false as const, reason: "diagnostic_invalid" };
  await session.query(
    "UPDATE crm_acquisition_diagnostic_authorizations SET revoked_at=clock_timestamp(),revocation_reference=$3 WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL",
    [input.workspaceId, input.authorizationId, input.reference],
  );
  return {
    ok: true as const,
    value: { authorizationId: input.authorizationId },
  };
}

/** Pre-consent isolation has no acquisition grant or source scope. It authorizes neither
 * capture nor sending; normal routes still verify their own current actor and OAuth state. */
export async function prepareCrmAcquisitionDiagnosticConsentIsolation(
  context: RepositoryContext,
  runtime?: CrmAcquisitionDiagnosticRuntime,
): Promise<boolean> {
  if (!runtime?.consentIsolationBinding) return false;
  const readConnection = async () =>
    (
      await context.db.query<{ name: string; address: string | null }>(
        "SELECT current_database() AS name,inet_server_addr()::text AS address",
      )
    ).rows[0];
  try {
    const before = await readConnection();
    if (!before || !/^fss[_-]diagnostic[_-]/u.test(before.name)) return false;
    if (
      !(await runtime.verifyIsolation({
        ...runtime.consentIsolationBinding,
        environmentId: runtime.environmentId,
        databaseName: before.name,
        connectedServerAddress: before.address,
        deploymentIdentity: "",
        purpose: "oauth_bootstrap",
      }))
    )
      return false;
    const after = await readConnection();
    return after?.name === before.name && after.address === before.address;
  } catch {
    return false;
  }
}
