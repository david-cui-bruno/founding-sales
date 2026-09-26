import type { Queryable } from '@fss/domain/db/queryable.ts';
import { acknowledgeCriticalAlert, listOpenAlerts, type OpenAlert } from '@fss/domain/jobs/criticalAlerts.ts';
import { listDeadJobs, requeueDeadJob, type DeadJob } from '@fss/domain/jobs/jobStore.ts';
import { contextFor, scopeForPrincipal, type VerifiedPrincipal } from '../../scope.ts';
import { REFUSAL_STATUS, redactError, type RedactedError } from '../../limits.ts';

/**
 * The admin job and alert routes (specification 5.2, 13.2, 13.3).
 *
 * Three commands and two reads, all admin-only:
 *
 * * `GET  /admin/jobs/dead` — the dead-job list. "Exhausted jobs become dead, are
 *   visible to admins, and are requeueable only by an audited admin command."
 * * `POST /admin/jobs/requeue` — that command. The idempotency key is unchanged, so a
 *   requeue can never materialize a second copy of work that already exists, and the
 *   audit event commits with the state transition (Appendix A).
 * * `GET  /admin/alerts` — the open alerts.
 * * `POST /admin/alerts/acknowledge` — the acknowledgement that stops
 *   `UnacknowledgedCriticalAlertAgeSeconds` being published, and therefore stops the
 *   repeating critical mail (docs/decisions/g1-alert-repetition.md).
 *
 * Authorization is `isAdminScope` inside the domain command rather than a check here,
 * so a second caller cannot reach the mutation past a route-level guard. This module
 * refuses non-admins too, but only as the first of two gates.
 *
 * The router is a pure function of method, path, principal and body: it takes a
 * verified principal rather than a request, so the session and device verification
 * that produces one (G2) is wired in one place and this file cannot bypass it.
 */

export interface AdminJobsRequest {
  readonly method: string;
  readonly path: string;
  /** Null for an unauthenticated request; the routes below all refuse one. */
  readonly principal: VerifiedPrincipal | null;
  readonly body?: Readonly<Record<string, unknown>> | undefined;
  readonly db: Queryable;
}

export type AdminJobsResponse =
  | { readonly status: 200; readonly body: { readonly deadJobs: readonly DeadJob[] } }
  | { readonly status: 200; readonly body: { readonly alerts: readonly OpenAlert[] } }
  | { readonly status: 200; readonly body: { readonly requeued: true; readonly jobId: string; readonly kind: string } }
  | { readonly status: 200; readonly body: { readonly acknowledged: true; readonly alertKey: string } }
  | { readonly status: number; readonly body: RedactedError }
  | null;

/** The paths this module owns. Exported so the router that mounts it cannot guess. */
export const ADMIN_JOBS_PATHS = [
  '/admin/jobs/dead',
  '/admin/jobs/requeue',
  '/admin/alerts',
  '/admin/alerts/acknowledge',
] as const;

export const FORBIDDEN_STATUS = 403;

function forbidden(): AdminJobsResponse {
  // `unauthenticated`'s message is the closest redacted sentence the closed set has;
  // an admin-only refusal must not tell a salesperson which endpoints exist.
  return { status: FORBIDDEN_STATUS, body: redactError('unauthenticated') };
}

function stringField(body: Readonly<Record<string, unknown>> | undefined, name: string): string | null {
  const value = body?.[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Handle an admin jobs request, or return null when the path is not one of ours so the
 * caller's router can carry on. Never throws for a refusal; a refusal is a response.
 */
export async function routeAdminJobs(request: AdminJobsRequest): Promise<AdminJobsResponse> {
  if (!(ADMIN_JOBS_PATHS as readonly string[]).includes(request.path)) return null;

  if (request.principal === null) {
    return { status: REFUSAL_STATUS.unauthenticated, body: redactError('unauthenticated') };
  }
  const outcome = scopeForPrincipal(request.principal);
  if (!outcome.authorized) return forbidden();
  if (request.principal.role !== 'admin') return forbidden();
  const context = contextFor(outcome.scope, request.db);

  switch (request.path) {
    case '/admin/jobs/dead': {
      if (request.method !== 'GET') {
        return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
      }
      return { status: 200, body: { deadJobs: await listDeadJobs(context, { limit: 100 }) } };
    }
    case '/admin/jobs/requeue': {
      if (request.method !== 'POST') {
        return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
      }
      const jobId = stringField(request.body, 'jobId');
      const reason = stringField(request.body, 'reason');
      if (jobId === null || reason === null) {
        return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
      }
      const requeued = await requeueDeadJob(context, { jobId, reason });
      if (!requeued.requeued) {
        return requeued.reason === 'not_admin'
          ? forbidden()
          : { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
      }
      return { status: 200, body: { requeued: true, jobId: requeued.jobId, kind: requeued.kind } };
    }
    case '/admin/alerts': {
      if (request.method !== 'GET') {
        return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
      }
      return { status: 200, body: { alerts: await listOpenAlerts(context) } };
    }
    case '/admin/alerts/acknowledge': {
      if (request.method !== 'POST') {
        return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
      }
      const alertId = stringField(request.body, 'alertId');
      if (alertId === null) {
        return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
      }
      const note = stringField(request.body, 'note');
      const acknowledged = await acknowledgeCriticalAlert(context, { alertId, note: note ?? undefined });
      if (!acknowledged.acknowledged) {
        return acknowledged.reason === 'not_admin'
          ? forbidden()
          : { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
      }
      return { status: 200, body: { acknowledged: true, alertKey: acknowledged.alertKey } };
    }
    default:
      return null;
  }
}
