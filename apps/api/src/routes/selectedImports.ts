import {
  selectedImportInputSchema,
  selectedImportCommitSchema,
  selectedImportReadSchema,
  selectedImportChangeSchema,
  selectedImportCorrectSchema,
} from "@fss/contracts";
import {
  previewSelectedImport,
  commitSelectedImport,
  readSelectedImports,
  changeSelectedImport,
} from "@fss/domain/crm/selectedImports.ts";
import { withTransaction } from "@fss/domain/db/queryable.ts";
import {
  requirePrincipal,
  contextForPrincipal,
  runRouteCommand,
} from "./routeSupport.ts";
import { redactError } from "../limits.ts";
import type { ApiRequest, RoutingOptions, RouteResult } from "./types.ts";
export const SELECTED_IMPORT_PATHS = [
  "/crm/imports/preview",
  "/crm/imports/commit",
  "/crm/imports/read",
  "/crm/imports/delete",
  "/crm/imports/restore",
  "/crm/imports/correct",
  "/crm/imports/recapture",
] as const;
export async function routeSelectedImports(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<RouteResult | null> {
  if (!(SELECTED_IMPORT_PATHS as readonly string[]).includes(request.path))
    return null;
  if (options.auth === undefined)
    return { status: 401, body: redactError("unauthenticated") };
  const verified = await requirePrincipal(options.auth, request);
  if (!verified.ok) return verified.result;
  const scoped = contextForPrincipal(options.auth, verified.principal);
  if (!scoped.ok) return scoped.result;
  if (request.method !== "POST")
    return { status: 405, body: redactError("method_not_allowed") };
  if (request.path === "/crm/imports/commit")
    return runRouteCommand(
      { auth: options.auth, request, principal: verified.principal },
      selectedImportCommitSchema,
      "crm.selected_import_committed",
      (context, body) => commitSelectedImport(context, body),
    );
  if (request.path.endsWith("delete") || request.path.endsWith("restore"))
    return runRouteCommand(
      { auth: options.auth, request, principal: verified.principal },
      selectedImportChangeSchema,
      "crm.selected_import_changed",
      (context, body) =>
        changeSelectedImport(
          context,
          body,
          request.path.endsWith("delete") ? "delete" : "restore",
        ),
    );
  if (request.path.endsWith("correct") || request.path.endsWith("recapture"))
    return runRouteCommand(
      { auth: options.auth, request, principal: verified.principal },
      selectedImportCorrectSchema,
      "crm.selected_import_changed",
      (context, body) =>
        changeSelectedImport(
          context,
          body,
          request.path.endsWith("correct") ? "correct" : "recapture",
          body,
        ),
    );
  const parsed = request.path.endsWith("preview")
    ? selectedImportInputSchema.safeParse(request.body)
    : selectedImportReadSchema.safeParse(request.body);
  if (!parsed.success)
    return { status: 400, body: redactError("malformed_body") };
  const result = await withTransaction(options.auth.db, async () =>
    request.path.endsWith("preview")
      ? previewSelectedImport(
          scoped.context,
          selectedImportInputSchema.parse(parsed.data),
        )
      : readSelectedImports(
          scoped.context,
          selectedImportReadSchema.parse(parsed.data),
        ),
  );
  return result === null
    ? { status: 404, body: redactError("not_found") }
    : { status: 200, body: result };
}
