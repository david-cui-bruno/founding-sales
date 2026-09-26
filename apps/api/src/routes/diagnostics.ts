import { publishedClientVersions } from '@fss/contracts';
import { readAppliedSchemaVersion } from '@fss/domain/db/migrationRunner.ts';
import { API_SCHEMA_RANGE } from '@fss/domain/db/schemaRange.ts';
import { readDiagnostics } from '@fss/domain/dashboard/diagnostics.ts';
import { attestedReleaseBinding } from '@fss/domain/release/records.ts';
import { effectiveSendingEnabled } from '@fss/domain/settings/effective.ts';
import { readSetting } from '@fss/domain/settings/store.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Diagnostics (specification 4.2, 5.3, 12.3, 13.3, Appendix E, Appendix F).
 *
 * `/health` is the load balancer's and the operator's fuller report, and `/readyz`
 * fails closed for the target group. This is neither: it is the page a person opens
 * inside the Mac when something is wrong, and it is authenticated, workspace-scoped
 * and subject to the read matrix — the mailbox panel is Appendix F row 3, so an
 * admin sees every mailbox and a salesperson only their own.
 *
 * A GET, unlike the dashboard: it takes no parameters at all. There is nothing to put
 * in a body and nothing that could leak into a URL.
 */
export const DIAGNOSTICS_PATHS: readonly string[] = ['/diagnostics'];

export async function routeDiagnostics(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!DIAGNOSTICS_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const scoped = contextForPrincipal(prepared.deps.auth, prepared.deps.principal);
  if (!scoped.ok) return scoped.result;

  const appliedSchemaVersion = await readAppliedSchemaVersion(options.session);
  const sendingSetting = await readSetting(scoped.context, 'sending_enabled');

  return {
    status: 200,
    body: await readDiagnostics(scoped.context, {
      appliedSchemaVersion,
      declaredRange: { minimum: API_SCHEMA_RANGE.minimum, maximum: API_SCHEMA_RANGE.maximum },
      // The published range, not the policy: `/diagnostics` is parsed by every
      // installed Mac with a strict `{ minimum, maximum }` (lane g78).
      clientVersions: publishedClientVersions(options.supportedClientVersions),
      deploymentSendingEnabled: options.sendingEnabled,
      // Only the admin half. `effectiveSendingEnabled` ANDs them, and the DTO shows
      // all three so an operator can see which half is off. Since lane g71 the admin
      // half holds only while the release record it names binds to this API's image,
      // the same answer `GET /settings` gives.
      adminSendingEnabled:
        effectiveSendingEnabled(true, sendingSetting.value) &&
        (
          await attestedReleaseBinding(scoped.context, sendingSetting.value, 'api', options.imageDigest, {
            production: options.production ?? true,
          })
        )?.ok === true,
    }),
  };
}
