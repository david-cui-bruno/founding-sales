import { z } from 'zod';
import {
  commandIdSchema,
  enrollableOriginKindSchema,
  enrollmentMigrateCommandSchema,
  semanticVersionSchema,
  uuid,
} from '@fss/contracts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import { enrollContact, stopEnrollments } from '@fss/domain/sequences/enrollments.ts';
import { migrateEnrollment } from '@fss/domain/sequences/migrateEnrollment.ts';
import { listEnrollments, listStepExecutions } from '@fss/domain/sequences/rows.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Enrollment and the hold review (specification 11.2, 4.3, 14.1).
 *
 * Every mutation is a command with a receipt. The LinkedIn task card's three paths
 * went with LinkedIn on 25 September 2026, and the audited migration's three
 * (`/enrollments/migrate/propose`, `/approve`, `/apply`) with wave 2's edit in place
 * (S3).
 *
 * `/enrollments/migrate` (send-path v2, S2) is the one way a running enrollment reaches
 * a newer published version, now that an edit writes a new version and never touches a
 * published one: one command, one transaction, by supersede — the old enrollment ends
 * `migration_superseded`, a new one starts at the step after its completed prefix on the
 * original cadence anchor, and a `follow_up` run moves only on a fresh permission for the
 * target (`packages/domain/sequences/migrateEnrollment.ts`). An administrator or the
 * firm's assigned salesperson may ask; the domain decides and audits.
 *
 * `/enrollments/resume` and `/enrollments/resume/preview` went with the 1.0.14 minimum
 * (lane W3-C2). They existed for the seven-day review, which wave 2 (S4.1) replaced
 * with a resume the scheduler performs on its own once the holds clear; no installed
 * build has shown the review since 1.0.12, and migration 0021 removes the
 * `review_required` state they were about.
 */
export const ENROLLMENT_PATHS: readonly string[] = [
  '/enrollments',
  '/enrollments/enroll',
  '/enrollments/stop',
  '/enrollments/steps',
  '/enrollments/migrate',
];

const command = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

/**
 * Enrolling names what it is for (migration 0025). `originKind` is required and there
 * is no default: `cold_legacy` is the column's default and it is history, so a command
 * that inherited it would create an enrollment nothing will ever send. A `follow_up`
 * carries the permission it rests on, and `enrollContact` re-reads that permission's
 * own evidence before it writes a row.
 */
const enrollSchema = z.strictObject({
  ...command,
  sequenceVersionId: uuid,
  opportunityId: uuid,
  firmId: uuid,
  contactId: uuid,
  originKind: enrollableOriginKindSchema,
  permissionId: uuid.optional(),
});

const stopSchema = z.strictObject({
  ...command,
  enrollmentId: uuid.optional(),
  firmId: uuid.optional(),
});

const listSchema = z.strictObject({
  firmId: uuid.optional(),
  contactId: uuid.optional(),
  liveOnly: z.boolean().optional(),
});

const stepsSchema = z.strictObject({ enrollmentId: uuid });

export async function routeEnrollments(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<RouteResult | null> {
  if (!request.path.startsWith('/enrollments')) return null;
  if (!ENROLLMENT_PATHS.includes(request.path)) return null;

  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  if (request.path === '/enrollments') {
    const parsed = listSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    }
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    return {
      status: 200,
      body: {
        // Database time travels with the list, so a deadline the Mac shows is the
        // server's and never this Mac's clock.
        asOf: await databaseNow(scoped.context),
        enrollments: await listEnrollments(scoped.context, {
          ...(parsed.data.firmId === undefined ? {} : { firmId: parsed.data.firmId }),
          ...(parsed.data.contactId === undefined ? {} : { contactId: parsed.data.contactId }),
          ...(parsed.data.liveOnly === undefined ? {} : { liveOnly: parsed.data.liveOnly }),
        }),
      },
    };
  }

  if (request.path === '/enrollments/steps') {
    const parsed = stepsSchema.safeParse(request.body);
    if (!parsed.success) {
      return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    }
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    return {
      status: 200,
      body: { steps: await listStepExecutions(scoped.context, { enrollmentId: parsed.data.enrollmentId }) },
    };
  }

  if (request.path === '/enrollments/enroll') {
    return await runPolicyCommand(deps, enrollSchema, 'enroll_contact', async (context, body) =>
      await enrollContact(context, {
        sequenceVersionId: body.sequenceVersionId,
        opportunityId: body.opportunityId,
        firmId: body.firmId,
        contactId: body.contactId,
        originKind: body.originKind,
        ...(body.permissionId === undefined ? {} : { permissionId: body.permissionId }),
        commandId: body.commandId,
      }),
    );
  }

  if (request.path === '/enrollments/stop') {
    return await runPolicyCommand(deps, stopSchema, 'stop_enrollments', async (context, body) => {
      if (body.enrollmentId === undefined && body.firmId === undefined) {
        return { ok: false, reason: 'invalid_input' };
      }
      const stopped = await stopEnrollments(context, {
        ...(body.enrollmentId === undefined ? {} : { enrollmentId: body.enrollmentId }),
        ...(body.firmId === undefined ? {} : { firmId: body.firmId }),
        reason: 'admin_stop',
      });
      return { ok: true, value: stopped };
    });
  }

  if (request.path === '/enrollments/migrate') {
    return await runPolicyCommand(deps, enrollmentMigrateCommandSchema, 'migrate_enrollment', async (context, body) => {
      const migrated = await migrateEnrollment(context, {
        enrollmentId: body.enrollmentId,
        targetSequenceVersionId: body.targetSequenceVersionId,
        ...(body.permissionId === undefined ? {} : { permissionId: body.permissionId }),
        ...(body.changeNote === undefined ? {} : { changeNote: body.changeNote }),
      });
      if (!migrated.ok) return migrated;
      // Exactly `enrollmentMigrateResultSchema`, `rescheduledTo` included (the instant a
      // past-due next step was moved to; PR 335 review, P1-6). Whether the new enrollment completed at
      // once is on the enrollment itself, which the Mac reads anyway.
      const { oldEnrollmentId, newEnrollmentId, carriedOrdinals, nextOrdinal, rescheduledTo } = migrated.value;
      return { ok: true, value: { oldEnrollmentId, newEnrollmentId, carriedOrdinals, nextOrdinal, rescheduledTo } };
    });
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}
