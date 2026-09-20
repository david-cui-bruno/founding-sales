import { z } from 'zod';
import { commandIdSchema, semanticVersionSchema, uuid } from '@fss/contracts';
import {
  createDraftVersion,
  createSequence,
  listSequenceVersions,
  listSequences,
  publishVersion,
  recordHolidayCalendar,
  replaceDraftSteps,
  retireVersion,
} from '@fss/domain/sequences';
import {
  REFUSAL_STATUS,
  contextForPrincipal,
  policyRouteDeps,
  redactError,
  runPolicyCommand,
} from './dialSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Sequence definition and publication (specification 11.1, 14.1).
 *
 * Exact paths, which is what every new endpoint in this repository is. A mistyped
 * path under `/sequences` is a command an admin is about to publish a plan with, and
 * `not_found` from the registry before any module sees it is the right answer.
 *
 * Every write is a `runPolicyCommand`, so the receipt, the payload hash, the device
 * and the mutation commit in one transaction (5.3). No route decides who may publish:
 * the domain command asks `isAdminScope` and returns a refusal value, which the
 * receipt records.
 *
 * The two reads are POSTs for the reason in `docs/decisions/g3b-reads-are-posts.md`:
 * a rule that applies to some of a family is a rule somebody gets wrong on the rest.
 */
export const SEQUENCE_PATHS: readonly string[] = [
  '/sequences',
  '/sequences/create',
  '/sequences/versions',
  '/sequences/versions/draft',
  '/sequences/versions/steps',
  '/sequences/versions/publish',
  '/sequences/versions/retire',
  '/sequences/holidays',
];

const command = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

const delaySchema = z.union([
  z.strictObject({ unit: z.literal('elapsed'), hours: z.number().int().min(0).max(8760) }),
  z.strictObject({ unit: z.literal('business_days'), days: z.number().int().min(0).max(365) }),
]);

const stepSchema = z.strictObject({
  ordinal: z.number().int().min(1).max(50),
  channel: z.enum(['email', 'call_task', 'linkedin_task']),
  delay: delaySchema,
  onNoAnswer: z.enum(['advance', 'retry_call']).optional(),
  templateVersionId: uuid.optional(),
  linkedInMessage: z.string().trim().min(1).max(1200).optional(),
});

const createSequenceSchema = z.strictObject({
  ...command,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(1000).optional(),
});

const draftSchema = z.strictObject({
  ...command,
  sequenceId: uuid,
  steps: z.array(stepSchema).max(50).optional(),
});

const stepsSchema = z.strictObject({
  ...command,
  sequenceVersionId: uuid,
  steps: z.array(stepSchema).max(50),
});

const versionCommandSchema = z.strictObject({ ...command, sequenceVersionId: uuid });

const holidaySchema = z.strictObject({
  ...command,
  version: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/u),
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)).max(400),
});

const listVersionsSchema = z.strictObject({ sequenceId: uuid });

export async function routeSequences(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<RouteResult | null> {
  if (!request.path.startsWith('/sequences')) return null;
  if (!SEQUENCE_PATHS.includes(request.path)) return null;

  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.path === '/sequences') {
    if (request.method !== 'GET') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    return { status: 200, body: { sequences: await listSequences(scoped.context) } };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  if (request.path === '/sequences/versions') {
    const parsed = listVersionsSchema.safeParse(request.body);
    if (!parsed.success) {
      return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    }
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    return {
      status: 200,
      body: { versions: await listSequenceVersions(scoped.context, parsed.data.sequenceId) },
    };
  }

  if (request.path === '/sequences/create') {
    return await runPolicyCommand(deps, createSequenceSchema, 'create_sequence', async (context, body) =>
      await createSequence(context, {
        name: body.name,
        ...(body.description === undefined ? {} : { description: body.description }),
      }),
    );
  }

  if (request.path === '/sequences/versions/draft') {
    return await runPolicyCommand(deps, draftSchema, 'create_sequence_draft', async (context, body) =>
      await createDraftVersion(context, {
        sequenceId: body.sequenceId,
        ...(body.steps === undefined ? {} : { steps: body.steps }),
      }),
    );
  }

  if (request.path === '/sequences/versions/steps') {
    return await runPolicyCommand(deps, stepsSchema, 'replace_sequence_steps', async (context, body) =>
      await replaceDraftSteps(context, {
        sequenceVersionId: body.sequenceVersionId,
        steps: body.steps,
      }),
    );
  }

  if (request.path === '/sequences/versions/publish') {
    return await runPolicyCommand(deps, versionCommandSchema, 'publish_sequence_version', async (context, body) =>
      await publishVersion(context, { sequenceVersionId: body.sequenceVersionId }),
    );
  }

  if (request.path === '/sequences/versions/retire') {
    return await runPolicyCommand(deps, versionCommandSchema, 'retire_sequence_version', async (context, body) =>
      await retireVersion(context, { sequenceVersionId: body.sequenceVersionId }),
    );
  }

  if (request.path === '/sequences/holidays') {
    return await runPolicyCommand(deps, holidaySchema, 'record_holiday_calendar', async (context, body) =>
      await recordHolidayCalendar(context, { version: body.version, dates: body.dates }),
    );
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}
