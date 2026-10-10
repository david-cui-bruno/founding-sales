import { z } from "zod";
import { readAppliedSchemaVersion } from "@fss/domain/db/migrationRunner.ts";
import { businessAccountBinding } from "@fss/domain/business/acquisition.ts";
import { CRM_MAIL_CAPTURE_DISCLOSURE } from "@fss/domain/crm/capabilityAuthority.ts";
import type { AdminInvocation, AdminOutcome } from "./admin.ts";
const refused = (reason: string): AdminOutcome => ({
  ok: false,
  reason,
  detail: "Diagnostic bindings unavailable; no authority granted.",
});
/** Trusted, exact-scope preparation read. Never creates consent, grants or capability settings. */
export async function crmAcquisitionDiagnosticBindingsCommand(
  invocation: AdminInvocation,
): Promise<AdminOutcome> {
  const input = z
    .strictObject({
      workspaceId: z.uuid(),
      mailboxId: z.uuid(),
      ownerUserId: z.uuid(),
    })
    .safeParse({
      workspaceId: invocation.options["--workspace"],
      mailboxId: invocation.options["--mailbox"],
      ownerUserId: invocation.options["--owner"],
    });
  if (!input.success) return refused("diagnostic_bindings_malformed");
  if (invocation.config.environmentName !== "rehearsal")
    return refused("diagnostic_bindings_environment_mismatch");
  const { workspaceId, mailboxId, ownerUserId } = input.data;
  const db = invocation.session;
  let transaction = false;
  try {
    await db.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    transaction = true;
    await db.query("SET LOCAL statement_timeout='5000ms'");
    await db.query("SET LOCAL lock_timeout='1000ms'");
    const trusted = (
      await db.query<{ allowed: boolean }>(
        "SELECT pg_has_role(current_user,'migration','USAGE') AS allowed",
      )
    ).rows[0]?.allowed;
    if (trusted !== true) return refused("trusted_operations_required");
    const database = (
      await db.query<{ name: string }>("SELECT current_database() AS name")
    ).rows[0]?.name;
    const version = await readAppliedSchemaVersion(db);
    if (
      !database ||
      !/^fss[_-]diagnostic[_-]/u.test(database) ||
      version !== 90
    )
      return refused("diagnostic_bindings_environment_mismatch");
    const membership = (
      await db.query<{ role: string; status: string }>(
        "SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
        [workspaceId, ownerUserId],
      )
    ).rows[0];
    if (membership?.status !== "active" || membership.role !== "admin")
      return refused("diagnostic_bindings_owner_unavailable");
    const mailbox = (
      await db.query<{
        id: string;
        owner_user_id: string;
        email_address: string;
        provider_account_id: string | null;
        generation: number;
        status: string;
      }>(
        "SELECT id,owner_user_id,email_address,provider_account_id,generation,status FROM mailboxes WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3",
        [workspaceId, mailboxId, ownerUserId],
      )
    ).rows[0];
    if (
      !mailbox ||
      mailbox.status !== "connected" ||
      !mailbox.provider_account_id
    )
      return refused("diagnostic_bindings_mailbox_unavailable");
    const observation = (
      await db.query<{ id: string; granted_scopes: string[] }>(
        "SELECT id,granted_scopes FROM mailbox_oauth_grant_observations WHERE workspace_id=$1 AND mailbox_id=$2 AND owner_user_id=$3 AND provider_account_id=$4 AND generation=$5 ORDER BY observed_at DESC,id DESC LIMIT 1",
        [
          workspaceId,
          mailboxId,
          ownerUserId,
          mailbox.provider_account_id,
          mailbox.generation,
        ],
      )
    ).rows[0];
    if (
      !observation ||
      observation.granted_scopes.length !== 1 ||
      observation.granted_scopes[0] !==
        "https://www.googleapis.com/auth/gmail.readonly"
    )
      return refused("diagnostic_bindings_consent_unavailable");
    const binding = businessAccountBinding(workspaceId, mailbox);
    if (!binding) return refused("diagnostic_bindings_mailbox_unavailable");
    return {
      ok: true,
      value: {
        workspaceId,
        mailboxId,
        ownerUserId,
        providerAccountId: mailbox.provider_account_id,
        generation: mailbox.generation,
        accountBinding: binding,
        oauthGrantObservationId: observation.id,
        databaseName: database,
        schemaVersion: version,
        disclosureVersion: CRM_MAIL_CAPTURE_DISCLOSURE.version,
        disclosureSha256: CRM_MAIL_CAPTURE_DISCLOSURE.sha256,
        readOnly: true,
        productionActivationAllowed: false,
      },
    };
  } catch {
    return refused("diagnostic_bindings_unavailable");
  } finally {
    if (transaction) {
      try {
        await db.query("ROLLBACK");
      } catch {
        /* CLI closes the session; no private error text leaves this command. */
      }
    }
  }
}
