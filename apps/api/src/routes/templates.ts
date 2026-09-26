import { z } from 'zod';
import { commandIdSchema, semanticVersionSchema, uuid } from '@fss/contracts';
import {
  approveTemplateVersion,
  createTemplateVersion,
  listTemplateVersions,
  retireTemplateVersion,
} from '@fss/domain/templates';
import {
  REFUSAL_STATUS,
  contextForPrincipal,
  policyRouteDeps,
  redactError,
  runPolicyCommand,
} from './dialSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Template versions and their approval (specification 11.1, 12.6, 14.1).
 *
 * The approval is the endpoint that matters. `approveTemplateVersion` runs G0's
 * `decideTemplateApproval`, whose refusal carries *every* issue rather than the
 * first, and the route passes them through: an author fixing one rule at a time is a
 * worse day than an author fixing four at once. That is why this family does not use
 * `runPolicyCommand`'s plain refusal shape for the approval — the reason code is
 * `template_unapproved` and the issues travel beside it.
 *
 * The copy rules (word count, links, price and guarantee wording) never refuse: a
 * create and an approval answer them as `warnings` on the accepted version
 * (`templateCommandResultSchema` in `@fss/contracts`).
 *
 * There is no endpoint that edits an approved version, and there never will be. The
 * database refuses it by trigger; the absence here is so that nobody has to find that
 * out from a 500.
 */
export const TEMPLATE_PATHS: readonly string[] = [
  '/templates',
  '/templates/create',
  '/templates/approve',
  '/templates/retire',
];

const command = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

const createSchema = z.strictObject({
  ...command,
  templateId: uuid.optional(),
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(4000),
  footerSignOff: z.string().trim().min(1).max(300),
  // No `footerPostalAddress`. The object is strict, so a client that still sends one
  // is a 400 rather than a field silently dropped: an automated email carries no
  // postal address (`docs/decisions/g20-automated-email-carries-no-postal-address.md`),
  // and a caller that believes otherwise should be told.
  requiredVariables: z.array(z.string().trim().min(1).max(60)).max(50),
});

const versionSchema = z.strictObject({ ...command, templateVersionId: uuid });

const listSchema = z.strictObject({ templateId: uuid.optional() });

export async function routeTemplates(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<RouteResult | null> {
  if (!request.path.startsWith('/templates')) return null;
  if (!TEMPLATE_PATHS.includes(request.path)) return null;

  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  if (request.path === '/templates') {
    const parsed = listSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    }
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    return {
      status: 200,
      body: {
        templates: await listTemplateVersions(scoped.context, {
          ...(parsed.data.templateId === undefined ? {} : { templateId: parsed.data.templateId }),
        }),
      },
    };
  }

  if (request.path === '/templates/create') {
    return await runPolicyCommand(deps, createSchema, 'create_template_version', async (context, body) =>
      await createTemplateVersion(context, {
        ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
        name: body.name,
        subject: body.subject,
        body: body.body,
        footer: { signOff: body.footerSignOff },
        requiredVariables: body.requiredVariables,
      }),
    );
  }

  if (request.path === '/templates/approve') {
    return await runPolicyCommand(deps, versionSchema, 'approve_template_version', async (context, body) => {
      const approved = await approveTemplateVersion(context, {
        templateVersionId: body.templateVersionId,
      });
      if (approved.ok) return approved;
      // The issues are the useful half of a refused approval; `reason` alone would
      // tell an author that something is wrong and not what.
      return {
        ok: false,
        reason:
          approved.issues === undefined
            ? approved.reason
            : `${approved.reason}:${approved.issues.join(',')}`,
      };
    });
  }

  if (request.path === '/templates/retire') {
    return await runPolicyCommand(deps, versionSchema, 'retire_template_version', async (context, body) =>
      await retireTemplateVersion(context, { templateVersionId: body.templateVersionId }),
    );
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}
