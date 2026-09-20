import { z } from 'zod';
import { commandIdSchema, semanticVersionSchema, uuid } from '@fss/contracts';
import {
  RETENTION_LEDGER_KINDS,
  commitDeletion,
  listRetentionRuns,
  previewDeletion,
  readRetentionPolicies,
  retentionBatchJobKey,
  retentionPeriodOf,
} from '@fss/domain/retention';
import { enqueueJob } from '@fss/domain/jobs';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal } from './crmSupport.ts';
import { runPolicyCommand } from './dialSupport.ts';
import { laneResultOf } from './retentionSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The retention surface (specification 10.3, 14.1).
 *
 * Four exact paths, and exact rather than a `/retention` prefix for the reason lane
 * G10 gave its own: an unknown path under this root is a typo in a command that
 * deletes prospect data, and `not_found` from the registry is the right answer before
 * any module sees it.
 *
 * Everything here is admin-only. Section 5.2 gives an admin "retention operations",
 * and the refusal comes from the domain command rather than from a check in this
 * file, because the domain is where it happens in the same transaction as the write.
 * The two reads check the role here as well, since there is no command to carry it.
 *
 * The deletion pair is a preview and a commit, both `runCommand`s. The preview writes
 * a row and is therefore a command with a receipt like any other; the commit presents
 * the hash the preview returned, and a world that has changed since makes them
 * disagree and the commit is refused.
 */

export const RETENTION_PATHS: readonly string[] = [
  '/retention/policies',
  '/retention/runs',
  '/retention/deletions/preview',
  '/retention/deletions/commit',
  '/retention/run',
];

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

const runSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  dataKind: z.enum(RETENTION_LEDGER_KINDS),
  /** Defaults to today's UTC day, which is the key the scheduler would have composed. */
  period: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u)
    .optional(),
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

  if (request.path === '/retention/policies' || request.path === '/retention/runs') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    const scoped = contextForPrincipal(auth, principal);
    if (!scoped.ok) return scoped.result;
    if (request.path === '/retention/policies') {
      return { status: 200, body: { policies: await readRetentionPolicies(scoped.context) } };
    }
    const dataKind = request.query.get('dataKind');
    return {
      status: 200,
      body: {
        runs: await listRetentionRuns(scoped.context, {
          ...(dataKind === null ? {} : { dataKind }),
        }),
      },
    };
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
          laneResultOf(
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
          laneResultOf(
            await commitDeletion(context, {
              requestId: body.requestId,
              previewHash: body.previewHash,
              commandId: body.commandId,
              journal: options.suppressionJournal,
            }),
          ),
      );
    case '/retention/run':
      return await runPolicyCommand(
        { auth, request, principal, journal: options.suppressionJournal },
        runSchema,
        'retention.run',
        async (context, body) => {
          // The command enqueues; it does not sweep. Section 13.1 keeps external and
          // long-running work behind the queue, and an admin asking for a sweep out of
          // band should get the same job the scheduler would have made — same kind,
          // same key — so asking twice cannot produce two sweeps.
          const period = body.period ?? retentionPeriodOf(new Date());
          const outcome = await enqueueJob(context.db, {
            workspaceId: context.scope.workspaceId,
            kind: 'retention.batch',
            idempotencyKey: retentionBatchJobKey(body.dataKind, period),
            payload: { dataKind: body.dataKind, period },
            maxAttempts: 6,
          });
          return { ok: true, value: { dataKind: body.dataKind, period, enqueued: outcome.inserted } };
        },
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
