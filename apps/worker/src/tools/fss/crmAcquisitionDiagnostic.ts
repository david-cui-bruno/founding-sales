import { readFile } from "node:fs/promises";
import { z } from "zod";
import { crmAcquisitionDiagnosticAuthorizationSchema } from "@fss/contracts";
import {
  crmAcquisitionDiagnosticFingerprint,
  provisionCrmAcquisitionDiagnostic,
  revokeCrmAcquisitionDiagnostic,
} from "@fss/domain/mail/crmAcquisitionDiagnostic.ts";
import type { AdminInvocation, AdminOutcome } from "./admin.ts";
const refused = (reason: string): AdminOutcome => ({
  ok: false,
  reason,
  detail: "Diagnostic authority refused; ordinary capabilities unchanged.",
});
export async function crmAcquisitionDiagnosticProvisionCommand(
  invocation: AdminInvocation,
): Promise<AdminOutcome> {
  let raw: unknown;
  try {
    const path = invocation.options["--json"],
      encoded = invocation.options["--json-base64"];
    const text =
      path !== undefined
        ? await readFile(path, "utf8")
        : encoded !== undefined &&
            encoded.length <= 32768 &&
            /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
          ? Buffer.from(encoded, "base64").toString("utf8")
          : null;
    if (text === null || Buffer.byteLength(text) > 16384)
      return refused("diagnostic_unreadable");
    raw = JSON.parse(text);
  } catch {
    return refused("diagnostic_unreadable");
  }
  const parsed = crmAcquisitionDiagnosticAuthorizationSchema.safeParse(raw);
  if (!parsed.success) return refused("diagnostic_malformed");
  if (
    crmAcquisitionDiagnosticFingerprint(parsed.data) !==
    invocation.options["--sha256"]
  )
    return refused("diagnostic_review_hash_mismatch");
  try {
    const outcome = await provisionCrmAcquisitionDiagnostic(
      invocation.session,
      parsed.data,
    );
    return outcome.ok
      ? { ok: true, value: outcome.value }
      : refused(outcome.reason);
  } catch {
    return refused("diagnostic_provision_refused");
  }
}
export async function crmAcquisitionDiagnosticRevokeCommand(
  invocation: AdminInvocation,
): Promise<AdminOutcome> {
  const parsed = z
    .strictObject({
      workspaceId: z.uuid(),
      authorizationId: z.uuid(),
      reference: z.string().min(1).max(200),
    })
    .safeParse({
      workspaceId: invocation.options["--workspace"],
      authorizationId: invocation.options["--authorization"],
      reference: invocation.options["--reference"],
    });
  if (!parsed.success) return refused("diagnostic_malformed");
  try {
    const outcome = await revokeCrmAcquisitionDiagnostic(
      invocation.session,
      parsed.data,
    );
    return outcome.ok
      ? { ok: true, value: outcome.value }
      : refused(outcome.reason);
  } catch {
    return refused("diagnostic_revoke_refused");
  }
}
