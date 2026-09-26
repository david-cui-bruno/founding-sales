import { z } from 'zod';
import { commandIdSchema, semanticVersionSchema, uuid } from '@fss/contracts';
import { commitDeletion, previewDeletion } from '@fss/domain/retention/deletion.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { runPolicyCommand } from './dialSupport.ts';
import { requirePrincipal } from './routeSupport.ts';
import { commandResultOf } from './retentionSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Deletion requests (specification 10.3, 10.2, 14.1).
 *
 * Two exact paths, and exact rather than a `/retention` prefix for the reason lane
 * G10 gave its own: an unknown path under this root is a typo in a command that
 * deletes prospect data, and `not_found` from the registry is the right answer before
 * any module sees it.
 *
 * Admin-only. Section 5.2 gives an admin "retention operations", and the refusal
 * comes from the domain command rather than from a check in this file, because the
 * domain is where it happens in the same transaction as the write.
 *
 * The pair is a preview and a commit, both `runCommand`s. The preview writes a row and
 * is therefore a command with a receipt like any other; the commit presents the hash
 * the preview returned, and a world that has changed since makes them disagree and the
 * commit is refused. The commit writes the handle and firm tombstones (journal first)
 * before it deletes anything, so a deleted prospect stays a stop fact.
 *
 * Wave 2 (S6) deleted these with the retention reads; the batch review restored the
 * pair, because it is the only way to write deletion tombstones. The Mac gets a
 * control for it later. `/retention/policies`, `/retention/runs` and `/retention/run`
 * stay deleted.
 */

export const RETENTION_PATHS: readonly string[] = ['/retention/deletions/preview', '/retention/deletions/commit'];

const previewSchema = z
  .strictObject({
    commandId: commandIdSchema,
    clientVersion: semanticVersionSchema,
    targetKind: z.enum(['firm', 'contact']),
    firmId: uuid,
    contactId: uuid.optional(),
  })
  // The database says the same thing (`deletion_requests_contact_named`); saying it
  // here as well means a firm deletion that quietly meant one contact is a 400 with a
  // name rather than a constraint violation halfway through a transaction.
  .refine(body => (body.targetKind === 'contact') === (body.contactId !== undefined), {
    message: 'a contact deletion names its contact and a firm deletion does not',
  });

const commitSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  requestId: uuid,
  previewHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

export async function routeRetention(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!RETENTION_PATHS.includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const principal = authenticated.principal;
  if (principal.role !== 'admin') {
    return { status: 403, body: { error: 'admin_only', message: 'The request was refused.' } };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/retention/deletions/preview':
      return await runPolicyCommand(
        { auth, request, principal, journal: options.suppressionJournal },
        previewSchema,
        'deletion.preview',
        async (context, body) =>
          commandResultOf(
            await previewDeletion(context, {
              targetKind: body.targetKind,
              firmId: body.firmId,
              ...(body.contactId === undefined ? {} : { contactId: body.contactId }),
            }),
          ),
      );
    case '/retention/deletions/commit':
      return await runPolicyCommand(
        { auth, request, principal, journal: options.suppressionJournal },
        commitSchema,
        'deletion.commit',
        async (context, body) =>
          // The journal comes from the routing options and every tombstone is written
          // to it before its row. A lost journal write throws out of `runCommand`,
          // rolls the receipt back with the deletion, and answers 503 — which is why
          // the tombstones are recorded before anything is deleted.
          commandResultOf(
            await commitDeletion(context, {
              requestId: body.requestId,
              previewHash: body.previewHash,
              commandId: body.commandId,
              journal: options.suppressionJournal,
            }),
          ),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
