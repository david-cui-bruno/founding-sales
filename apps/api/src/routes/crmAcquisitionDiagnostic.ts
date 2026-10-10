import {
  crmAcquisitionDiagnosticRequestSchema,
  crmAcquisitionDiagnosticReadSchema,
  crmAcquisitionDiagnosticReadResultSchema,
} from "@fss/contracts";
import {
  prepareCrmAcquisitionDiagnosticIsolation,
  requestCrmAcquisitionDiagnostic,
  readCrmAcquisitionDiagnostic,
} from "@fss/domain/mail/crmAcquisitionDiagnostic.ts";
import { withTransaction } from "@fss/domain/db/queryable.ts";
import {
  contextForPrincipal,
  requirePrincipal,
  runRouteCommand,
} from "./routeSupport.ts";
import { redactError } from "../limits.ts";
import type { ApiRequest, RoutingOptions, RouteResult } from "./types.ts";
export const CRM_ACQUISITION_DIAGNOSTIC_PATHS = [
  "/crm/business/mail/diagnostic/request",
  "/crm/business/mail/diagnostic/read",
];
export async function routeCrmAcquisitionDiagnostic(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<RouteResult | null> {
  if (!CRM_ACQUISITION_DIAGNOSTIC_PATHS.includes(request.path)) return null;
  if (!options.auth)
    return { status: 401, body: redactError("unauthenticated") };
  const verified = await requirePrincipal(options.auth, request);
  if (!verified.ok) return verified.result;
  const scoped = contextForPrincipal(options.auth, verified.principal);
  if (!scoped.ok) return scoped.result;
  if (request.method !== "POST")
    return { status: 405, body: redactError("method_not_allowed") };
  if (request.path === "/crm/business/mail/diagnostic/request") {
    const parsed = crmAcquisitionDiagnosticRequestSchema.safeParse(
      request.body,
    );
    if (!parsed.success)
      return { status: 400, body: redactError("malformed_body") };
    const proof = await prepareCrmAcquisitionDiagnosticIsolation(
      scoped.context,
      { authorizationId: parsed.data.authorizationId },
      options.crmAcquisitionDiagnosticRuntime,
    );
    return runRouteCommand(
      { auth: options.auth, request, principal: verified.principal },
      crmAcquisitionDiagnosticRequestSchema,
      "crm.acquisition_diagnostic_requested",
      (context, body) =>
        requestCrmAcquisitionDiagnostic(
          context,
          {
            authorizationId: body.authorizationId,
            expectedAuthorizationSha256: body.expectedAuthorizationSha256,
          },
          options.crmAcquisitionDiagnosticRuntime,
          proof ?? undefined,
        ),
    );
  }
  const parsed = crmAcquisitionDiagnosticReadSchema.safeParse(request.body);
  if (!parsed.success)
    return { status: 400, body: redactError("malformed_body") };
  const proof = await prepareCrmAcquisitionDiagnosticIsolation(
    scoped.context,
    parsed.data,
    options.crmAcquisitionDiagnosticRuntime,
    "progress_read",
  );
  const result = await withTransaction(options.auth.db, () =>
    readCrmAcquisitionDiagnostic(
      scoped.context,
      parsed.data,
      options.crmAcquisitionDiagnosticRuntime,
      proof ?? undefined,
    ),
  );
  return result === null
    ? { status: 404, body: redactError("not_found") }
    : {
        status: 200,
        body: crmAcquisitionDiagnosticReadResultSchema.parse(result),
      };
}
