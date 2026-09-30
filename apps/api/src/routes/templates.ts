import { z } from 'zod';
import { commandIdSchema, semanticVersionSchema, uuid } from '@fss/contracts';
import {
  createTemplateVersion,
  listTemplateVersions,
  updateTemplateVersion,
  type TemplateResult,
} from '@fss/domain/templates/templates.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Template versions: create, edit, approve (specification 11.1, 12.6, 14.1; wave 2, S3;
 * send-path v2, S2).
 *
 *   * `POST /templates/update` edits a version. An **approved** version is never
 *     rewritten: the edit is the template's next version, with its own id, number and
 *     content hash, and the answer is that new row. An unapproved version is edited in
 *     place, the hash recomputed. `approve: true` is "Save and approve": the saved
 *     version approved in the same command, or refused with every issue and nothing
 *     written.
 *   * `POST /templates/create` writes a new template, and takes `approve: true` too. It
 *     no longer takes a `templateId`: a new *version* of an existing template was the
 *     1.0.11 shape, and the 0021 release (lane W3-C2) retired it along with
 *     `POST /templates/approve`, which approved a version as it stood. `/templates/update`
 *     with `approve: true` is what replaced both.
 *
 * A refused approval carries *every* issue rather than the first, as
 * `template_unapproved:<issue>,<issue>`: an author fixing one rule at a time is a worse
 * day than an author fixing four at once. The copy rules (word count, links, price and
 * guarantee wording) never refuse: every accepted answer carries them as `warnings`, and
 * a save also carries `issues`, the refusal rules the text does not pass
 * (`templateSaveResultSchema` in `@fss/contracts`).
 */
export const TEMPLATE_PATHS: readonly string[] = ['/templates', '/templates/create', '/templates/update'];

const command = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

const text = {
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(4000),
  footerSignOff: z.string().trim().min(1).max(300),
  // No `footerPostalAddress`. The object is strict, so a client that still sends one
  // is a 400 rather than a field silently dropped: an automated email carries no
  // postal address (`docs/decisions/g20-automated-email-carries-no-postal-address.md`),
  // and a caller that believes otherwise should be told.
  requiredVariables: z.array(z.string().trim().min(1).max(60)).max(50),
  approve: z.boolean().optional(),
};

const createSchema = z.strictObject({ ...command, ...text });

const updateSchema = z.strictObject({ ...command, templateVersionId: uuid, ...text });

/** The issues are the useful half of a refused approval; `reason` alone would tell an author something is wrong and not what. */
function withIssues<T>(result: TemplateResult<T>): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string } {
  if (result.ok) return result;
  return {
    ok: false,
    reason: result.issues === undefined ? result.reason : `${result.reason}:${result.issues.join(',')}`,
  };
}

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
      withIssues(
        await createTemplateVersion(context, {
          name: body.name,
          subject: body.subject,
          body: body.body,
          footer: { signOff: body.footerSignOff },
          requiredVariables: body.requiredVariables,
          approve: body.approve,
        }),
      ),
    );
  }

  if (request.path === '/templates/update') {
    return await runPolicyCommand(deps, updateSchema, 'update_template_version', async (context, body) =>
      withIssues(
        await updateTemplateVersion(context, {
          templateVersionId: body.templateVersionId,
          name: body.name,
          subject: body.subject,
          body: body.body,
          footer: { signOff: body.footerSignOff },
          requiredVariables: body.requiredVariables,
          approve: body.approve,
        }),
      ),
    );
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}
