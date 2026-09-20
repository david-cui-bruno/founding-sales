import type { RepositoryContext } from '../db/workspaceScope.ts';
import { actorKind, actorUserId } from './types.ts';

/**
 * One audit event, written in the caller's transaction.
 *
 * `audit_events` has UPDATE, DELETE and TRUNCATE revoked from both application roles
 * in migration 0001, so this can only add. The API has its own `recordAuditEvent`
 * for identity; this is the domain's, and it exists because a CRM command commits
 * its audit event with its mutation (Appendix A) and the domain cannot import from
 * `apps/`.
 *
 * `detail` is identifiers and codes. Never a note, an address, a message body or a
 * person's name (5.2: "Audit records exclude secrets and unnecessary message
 * content").
 */
export async function recordCrmAuditEvent(
  context: RepositoryContext,
  event: {
    readonly action: string;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await context.db.query(
    `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      context.scope.workspaceId,
      actorKind(context),
      actorUserId(context),
      event.action,
      event.subjectKind,
      event.subjectId,
      JSON.stringify(event.detail ?? {}),
    ],
  );
}
