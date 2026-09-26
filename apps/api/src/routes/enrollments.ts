import { z } from 'zod';
import { commandIdSchema, semanticVersionSchema, uuid } from '@fss/contracts';
import { databaseNow } from '@fss/domain/policy';
import {
  enrollContact,
  listEnrollments,
  listStepExecutions,
  previewResume,
  resumeEnrollment,
  stopEnrollments,
} from '@fss/domain/sequences';
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
 * (S3), which reaches live enrollments without moving them to a new version.
 */
export const ENROLLMENT_PATHS: readonly string[] = [
  '/enrollments',
  '/enrollments/enroll',
  '/enrollments/stop',
  '/enrollments/steps',
  '/enrollments/resume',
  '/enrollments/resume/preview',
];

const command = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

const enrollSchema = z.strictObject({
  ...command,
  sequenceVersionId: uuid,
  opportunityId: uuid,
  firmId: uuid,
  contactId: uuid,
});

const stopSchema = z.strictObject({
  ...command,
  enrollmentId: uuid.optional(),
  firmId: uuid.optional(),
});

const enrollmentSchema = z.strictObject({ ...command, enrollmentId: uuid });


const listSchema = z.strictObject({
  firmId: uuid.optional(),
  contactId: uuid.optional(),
  liveOnly: z.boolean().optional(),
});

const stepsSchema = z.strictObject({ enrollmentId: uuid });

const previewSchema = z.strictObject({ enrollmentId: uuid });

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

  if (request.path === '/enrollments/resume/preview') {
    // "Review and resume" (4.3; lane g88, audit G06): the future steps and the dates a
    // confirmation would give them, computed by the function the confirmation runs. A
    // read — nothing is locked or written — so the person can look and walk away.
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) {
      return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    }
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    const preview = await previewResume(scoped.context, { enrollmentId: parsed.data.enrollmentId });
    if (!preview.ok) {
      return preview.reason === 'enrollment_unknown'
        ? { status: REFUSAL_STATUS.not_found, body: redactError('not_found') }
        : { status: 409, body: { status: 'refused', reason: preview.reason } };
    }
    return { status: 200, body: { asOf: await databaseNow(scoped.context), preview: preview.value } };
  }

  if (request.path === '/enrollments/enroll') {
    return await runPolicyCommand(deps, enrollSchema, 'enroll_contact', async (context, body) =>
      await enrollContact(context, {
        sequenceVersionId: body.sequenceVersionId,
        opportunityId: body.opportunityId,
        firmId: body.firmId,
        contactId: body.contactId,
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

  // Installed desktops up to 1.0.11 confirm a review here. Since wave 2 (S4.1) a long
  // hold resumes on its own, so this is the same resume the scheduler runs, asked now.
  if (request.path === '/enrollments/resume') {
    return await runPolicyCommand(deps, enrollmentSchema, 'resume_enrollment', async (context, body) =>
      await resumeEnrollment(context, { enrollmentId: body.enrollmentId }),
    );
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}
