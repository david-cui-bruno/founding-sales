import { deviceListSchema, revokeDeviceRequestSchema, type DeviceListEntry } from '@fss/contracts';
import type { QueryResultRowLike } from '@fss/domain/db/queryable.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { recordAuditEvent, actorOf } from '../auth/audit.ts';
import { revokeDevice } from '../auth/sessions.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { requirePrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * This workspace's Macs, and the one command that takes one away (specification 5.3).
 *
 * Wave 3b added these because there were none. The plan called admin revocation an
 * existing control; it was not — `/admin/devices` and `/admin/devices/revoke` were
 * deleted in wave 2 for having no caller, and the registry still asserts they are
 * unmounted. Without a list and a revoke, a lost Mac could only be dealt with by
 * editing `devices` by hand, which matters far more now that the secret in that Mac's
 * Keychain is a long-lived credential rather than a thing nothing ever asks for.
 *
 * Any active member may read the list and revoke a device. There is one person using
 * this system; a role gate here would be a second opinion about a question the
 * membership already answered, and lane S7b removes roles outright.
 *
 * Revoking one's own device is allowed, and it is a sign-out: `revokeDevice` ends
 * every session that device holds, including the one that asked. A device belonging to
 * another workspace is `device_unknown` — the same answer an id that never existed
 * gets, so the command cannot be used to find out which Macs exist elsewhere.
 */
export const DEVICE_PATHS: readonly string[] = ['/devices', '/devices/revoke'];

/** A refusal the state of the world made, not the request: 409, as every command uses. */
const CONFLICT_STATUS = 409;

interface DeviceRow extends QueryResultRowLike {
  readonly id: string;
  readonly device_label: string;
  readonly status: 'active' | 'revoked';
  readonly registered_at: Date;
  readonly last_seen_at: Date | null;
  readonly client_version: string | null;
}

export async function routeDevices(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!DEVICE_PATHS.includes(request.path)) return null;

  // The same rule the auth routes follow: a deployment without identity serves nothing
  // that needs it rather than half serving it.
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  if (request.path === '/devices') {
    if (request.method !== 'GET') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    const caller = await requirePrincipal(auth, request);
    if (!caller.ok) return caller.result;

    const { rows } = await auth.db.query<DeviceRow>(
      `SELECT id, device_label, status, registered_at, last_seen_at, client_version
         FROM devices
        WHERE workspace_id = $1
        ORDER BY registered_at DESC, id DESC`,
      [caller.principal.workspaceId],
    );
    const devices: DeviceListEntry[] = rows.map(row => ({
      deviceId: row.id,
      deviceLabel: row.device_label,
      status: row.status,
      registeredAt: row.registered_at.toISOString(),
      lastSeenAt: row.last_seen_at === null ? null : row.last_seen_at.toISOString(),
      clientVersion: row.client_version,
      thisDevice: row.id === caller.principal.deviceId,
    }));
    return { status: 200, body: deviceListSchema.parse(devices) };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  const caller = await requirePrincipal(auth, request);
  if (!caller.ok) return caller.result;
  const parsed = revokeDeviceRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };

  const principal = caller.principal;
  const deviceId = parsed.data.deviceId;
  return await withTransaction(auth.db, async () => {
    // Inside the transaction, so the device cannot be revoked and the event not
    // written, or the other way round.
    const found = await auth.db.query<{ id: string }>(
      'SELECT id FROM devices WHERE workspace_id = $1 AND id = $2',
      [principal.workspaceId, deviceId],
    );
    if (found.rows[0] === undefined) {
      return { status: CONFLICT_STATUS, body: { error: 'device_unknown', message: 'The request was refused.' } };
    }

    await revokeDevice(auth, { workspaceId: principal.workspaceId, deviceId, reason: 'device_revoked' });
    await recordAuditEvent(auth.db, {
      workspaceId: principal.workspaceId,
      actor: actorOf(principal),
      action: 'auth.device_revoked',
      subjectKind: 'device',
      subjectId: deviceId,
      detail: { revokedDeviceId: deviceId },
    });
    return { status: 200, body: { revoked: true, deviceId, thisDevice: deviceId === principal.deviceId } };
  });
}
