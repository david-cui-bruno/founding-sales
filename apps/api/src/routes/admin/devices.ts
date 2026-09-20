import { z } from 'zod';
import { commandIdSchema, deviceViewSchema, semanticVersionSchema, uuid } from '@fss/contracts';
import type { QueryResultRowLike } from '@fss/domain/db';
import { actorOf, recordAuditEvent, revokeDevice, runCommand } from '../../auth/index.ts';
import type { AuthDeps } from '../../auth/index.ts';
import { REFUSAL_STATUS, redactError } from '../../limits.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from '../types.ts';
import { commandReply, requireAdmin } from './memberships.ts';

/**
 * Device administration (specification 5.2, 5.3).
 *
 * The list is a redacted DTO: `deviceViewSchema` has no field that could hold a
 * secret hash, so the shape refuses to carry one rather than relying on this query
 * not to select it.
 *
 * Revocation goes through the same `revokeDevice` the credential-reuse path uses, so
 * an admin revoking a Mac and a thief revealing themselves end in exactly the same
 * state: device revoked, sessions ended, live credential spent, full sign-in required.
 */

const revokeSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  deviceId: uuid,
});

interface DeviceRow extends QueryResultRowLike {
  readonly id: string;
  readonly user_id: string;
  readonly device_label: string;
  readonly client_version: string | null;
  readonly status: 'active' | 'revoked';
  readonly credential_generation: string;
  readonly registered_at: Date;
  readonly last_seen_at: Date | null;
  readonly revoked_at: Date | null;
}

async function listDevices(auth: AuthDeps, workspaceId: string): Promise<unknown[]> {
  const { rows } = await auth.db.query<DeviceRow>(
    `SELECT id, user_id, device_label, client_version, status, credential_generation,
            registered_at, last_seen_at, revoked_at
       FROM devices
      WHERE workspace_id = $1
      ORDER BY registered_at DESC`,
    [workspaceId],
  );
  return rows.map(row =>
    deviceViewSchema.parse({
      deviceId: row.id,
      userId: row.user_id,
      deviceLabel: row.device_label,
      clientVersion: row.client_version,
      status: row.status,
      credentialGeneration: Number(row.credential_generation),
      registeredAt: row.registered_at.toISOString(),
      lastSeenAt: row.last_seen_at === null ? null : row.last_seen_at.toISOString(),
      revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    }),
  );
}

export async function routeAdminDevices(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/admin/devices')) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  const admin = await requireAdmin(auth, request);
  if (!admin.ok) return admin.result;
  const principal = admin.principal;

  if (request.path === '/admin/devices' && (request.method === 'GET' || request.method === 'HEAD')) {
    return { status: 200, body: { devices: await listDevices(auth, principal.workspaceId) } };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  if (request.path === '/admin/devices/revoke') {
    const parsed = revokeSchema.safeParse(request.body);
    if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
    const { deviceId } = parsed.data;

    const outcome = await runCommand(
      auth,
      principal,
      {
        commandId: parsed.data.commandId,
        kind: 'device.revoked',
        payload: { deviceId },
        clientVersion: parsed.data.clientVersion,
      },
      async () => {
        const present = await auth.db.query<{ id: string }>(
          'SELECT id FROM devices WHERE workspace_id = $1 AND id = $2',
          [principal.workspaceId, deviceId],
        );
        if (present.rows[0] === undefined) return { status: 'refused', reason: 'device_unknown' };
        await revokeDevice(auth, { workspaceId: principal.workspaceId, deviceId, reason: 'device_revoked' });
        await recordAuditEvent(auth.db, {
          workspaceId: principal.workspaceId,
          actor: actorOf(principal),
          action: 'device.revoked',
          subjectKind: 'device',
          subjectId: deviceId,
          // An admin revoking the Mac they are using is allowed, and worth recording.
          detail: { self: deviceId === principal.deviceId },
        });
        return { status: 'accepted', result: { deviceId, status: 'revoked' } };
      },
    );
    return commandReply(outcome);
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}
