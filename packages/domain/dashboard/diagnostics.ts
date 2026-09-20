import type { ClientVersionRange } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { readHeartbeats, type HeartbeatStatus } from '../jobs/heartbeats.ts';
import { canaryCompletionAgeSeconds } from '../jobs/canary.ts';
import { listOpenAlerts, type OpenAlert } from '../jobs/criticalAlerts.ts';
import { runbookForAlertKey } from './runbooks.ts';

/**
 * Diagnostics: the one page that answers "is this deployment healthy, and if not,
 * which part" (specification 4.2, 5.3, 12.3, 13.3, Appendix E, Appendix F).
 *
 * It is a read, and the thing worth being careful about is the third row of
 * Appendix F: "temporary private Gmail drafts, raw MIME, **mailbox diagnostics**,
 * OAuth metadata — mailbox owner or admin". So the mailbox panel is per caller: an
 * admin sees every mailbox, a salesperson sees their own and no other, and an admin
 * reading somebody else's writes the access audit event 5.2 asks for.
 *
 * Everything else here is operational rather than personal: schema version, client
 * version range, job counts, heartbeats, the canary, the restore generation and the
 * open alerts. None of it names a prospect.
 *
 * Each open alert carries the path of its runbook when its key is an alarm key, so
 * the answer to "what do I do about this" is one click from the thing that says it
 * is wrong, rather than a search through a documentation tree at three in the
 * morning.
 */

export interface JobHealth {
  readonly runnable: number;
  readonly running: number;
  readonly retryable: number;
  readonly dead: number;
  readonly oldestRunnableAgeSeconds: number | null;
  readonly oldestDeadAgeSeconds: number | null;
}

export interface MailboxDiagnostic {
  readonly mailboxId: string;
  readonly ownerUserId: string;
  readonly status: string;
  readonly syncState: string;
  readonly coverageWatermarkAt: string | null;
  readonly lastSyncedAt: string | null;
  /** Present, redacted and bounded. It names a stage, never a message. */
  readonly lastSyncError: string | null;
  readonly generation: number;
  readonly watchExpiresAt: string | null;
  readonly hoursToWatchExpiry: number | null;
  readonly automationHeld: boolean;
}

export interface AlertDiagnostic extends OpenAlert {
  /** Null when the alert key is not one of the infrastructure's alarm keys. */
  readonly runbookPath: string | null;
}

export interface DiagnosticsDto {
  /** Appendix E: the applied generation and the one the operator pinned. */
  readonly restore: {
    readonly systemGeneration: number | null;
    readonly expectedSystemGeneration: number | null;
    readonly mismatch: boolean;
  };
  readonly schema: {
    readonly appliedVersion: number;
    readonly declaredRange: { readonly minimum: number; readonly maximum: number };
    readonly accepted: boolean;
  };
  readonly clientVersions: ClientVersionRange;
  readonly sending: {
    /** The release process's half of 16.2. */
    readonly deploymentEnabled: boolean;
    /** The admin's half. */
    readonly adminEnabled: boolean;
    readonly effective: boolean;
  };
  readonly jobs: JobHealth;
  readonly heartbeats: readonly HeartbeatStatus[];
  readonly canaryCompletionAgeSeconds: number | null;
  readonly alerts: readonly AlertDiagnostic[];
  /** Appendix F row 3. Only the caller's own, unless the caller is an admin. */
  readonly mailboxes: readonly MailboxDiagnostic[];
  readonly mailboxVisibility: 'all' | 'own';
}

export interface DiagnosticsInput {
  readonly appliedSchemaVersion: number;
  readonly declaredRange: { readonly minimum: number; readonly maximum: number };
  readonly expectedSystemGeneration: number | null;
  readonly clientVersions: ClientVersionRange;
  readonly deploymentSendingEnabled: boolean;
  readonly adminSendingEnabled: boolean;
}

interface MailboxDbRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly status: string;
  readonly sync_state: string;
  readonly coverage_watermark_at: Date | null;
  readonly last_synced_at: Date | null;
  readonly last_sync_error: string | null;
  readonly generation: number;
  readonly watch_expires_at: Date | null;
  readonly hours_to_expiry: string | null;
  readonly held: boolean;
}

export async function readDiagnostics(
  context: RepositoryContext,
  input: DiagnosticsInput,
): Promise<DiagnosticsDto> {
  const actor = context.scope.actor;
  const isAdmin = actor.kind === 'system' || actor.role === 'admin';
  const ownerFilter = isAdmin ? null : actor.kind === 'user' ? actor.userId : null;

  const generationRow = await context.db.query<{ generation: string | null }>(
    'SELECT max(generation)::text AS generation FROM system_generations',
  );
  const systemGeneration =
    generationRow.rows[0]?.generation === null || generationRow.rows[0]?.generation === undefined
      ? null
      : Number(generationRow.rows[0].generation);

  const jobs = await context.db.query<{
    runnable: string;
    running: string;
    retryable: string;
    dead: string;
    oldest_runnable: string | null;
    oldest_dead: string | null;
  }>(
    `SELECT count(*) FILTER (WHERE state IN ('queued','retryable') AND run_at <= now() AND not_before <= now())::text
              AS runnable,
            count(*) FILTER (WHERE state = 'running')::text AS running,
            count(*) FILTER (WHERE state = 'retryable')::text AS retryable,
            count(*) FILTER (WHERE state = 'dead')::text AS dead,
            (min(greatest(run_at, not_before))
               FILTER (WHERE state IN ('queued','retryable') AND run_at <= now() AND not_before <= now())
             )::text AS oldest_runnable_at,
            extract(epoch FROM now() - min(greatest(run_at, not_before))
              FILTER (WHERE state IN ('queued','retryable') AND run_at <= now() AND not_before <= now()))::text
              AS oldest_runnable,
            extract(epoch FROM now() - min(dead_at) FILTER (WHERE state = 'dead'))::text AS oldest_dead
       FROM jobs
      WHERE workspace_id = $1`,
    [context.scope.workspaceId],
  );
  const jobRow = jobs.rows[0];

  const mailboxes = await context.db.query<MailboxDbRow>(
    `SELECT m.id, m.owner_user_id, m.status, m.sync_state, m.coverage_watermark_at, m.last_synced_at,
            m.last_sync_error, m.generation,
            w.expires_at AS watch_expires_at,
            extract(epoch FROM w.expires_at - now())::text AS hours_to_expiry,
            EXISTS (
              SELECT 1 FROM active_holds h
               WHERE h.workspace_id = m.workspace_id AND h.released_at IS NULL
                 AND h.scope_kind = 'mailbox' AND h.scope_key = m.id::text
            ) AS held
       FROM mailboxes m
       LEFT JOIN mailbox_watches w
              ON w.workspace_id = m.workspace_id AND w.mailbox_id = m.id
             AND w.generation = m.generation AND w.cancelled_at IS NULL
      WHERE m.workspace_id = $1 AND ($2::uuid IS NULL OR m.owner_user_id = $2::uuid)
      ORDER BY m.email_address`,
    [context.scope.workspaceId, ownerFilter],
  );

  // 5.2: "Admin reads of message bodies, drafts, mailbox diagnostics, and exports
  // create access audit events." An admin reading their own mailbox's diagnostics is
  // ordinary work; reading somebody else's is the case the sentence names.
  if (isAdmin && actor.kind === 'user') {
    const others = mailboxes.rows.filter(row => row.owner_user_id !== actor.userId).map(row => row.id);
    if (others.length > 0) {
      await recordCrmAuditEvent(context, {
        action: 'read.mailbox_diagnostics',
        subjectKind: 'mailbox',
        subjectId: others.join(','),
        detail: { count: others.length },
      });
    }
  }

  const alerts = await listOpenAlerts(context);

  return {
    restore: {
      systemGeneration,
      expectedSystemGeneration: input.expectedSystemGeneration,
      mismatch:
        input.expectedSystemGeneration !== null && systemGeneration !== input.expectedSystemGeneration,
    },
    schema: {
      appliedVersion: input.appliedSchemaVersion,
      declaredRange: input.declaredRange,
      accepted:
        input.appliedSchemaVersion >= input.declaredRange.minimum &&
        input.appliedSchemaVersion <= input.declaredRange.maximum,
    },
    clientVersions: input.clientVersions,
    sending: {
      deploymentEnabled: input.deploymentSendingEnabled,
      adminEnabled: input.adminSendingEnabled,
      effective: input.deploymentSendingEnabled && input.adminSendingEnabled,
    },
    jobs: {
      runnable: Number(jobRow?.runnable ?? '0'),
      running: Number(jobRow?.running ?? '0'),
      retryable: Number(jobRow?.retryable ?? '0'),
      dead: Number(jobRow?.dead ?? '0'),
      oldestRunnableAgeSeconds:
        jobRow?.oldest_runnable === null || jobRow?.oldest_runnable === undefined
          ? null
          : Number(jobRow.oldest_runnable),
      oldestDeadAgeSeconds:
        jobRow?.oldest_dead === null || jobRow?.oldest_dead === undefined ? null : Number(jobRow.oldest_dead),
    },
    heartbeats: await readHeartbeats(context.db),
    canaryCompletionAgeSeconds: await canaryCompletionAgeSeconds(context.db),
    alerts: alerts.map(alert => ({ ...alert, runbookPath: runbookForAlertKey(alert.alertKey)?.path ?? null })),
    mailboxes: mailboxes.rows.map(row => ({
      mailboxId: row.id,
      ownerUserId: row.owner_user_id,
      status: row.status,
      syncState: row.sync_state,
      coverageWatermarkAt: row.coverage_watermark_at?.toISOString() ?? null,
      lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
      lastSyncError: row.last_sync_error,
      generation: row.generation,
      watchExpiresAt: row.watch_expires_at?.toISOString() ?? null,
      hoursToWatchExpiry:
        row.hours_to_expiry === null ? null : Math.round((Number(row.hours_to_expiry) / 3600) * 10) / 10,
      automationHeld: row.held,
    })),
    mailboxVisibility: isAdmin ? 'all' : 'own',
  };
}
