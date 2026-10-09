import { readCrmProcessing, requestCrmProcessing, readCrmExtractionPurpose, saveCrmExtractionPurpose, readCrmProcessingHealth,readCrmProcessingRecord } from '@fss/domain/crm/processing.ts';
import { crmSourceLookupSchema, crmProcessingReadSchema, crmProcessingRequestSchema, crmExtractionPurposeSaveSchema, crmProcessingHealthReadSchema,crmProcessingRecordReadSchema } from '@fss/contracts';
import { resolveCrmSource } from '@fss/domain/crm/sourceResolver.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import { redactError } from '../limits.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';

export const CRM_PROCESSING_PATHS = ['/crm/processing/source/read', '/crm/processing/request', '/crm/processing/read', '/crm/processing/purpose/read', '/crm/processing/purpose/save', '/crm/processing/health/read','/crm/processing/record/read'] as const;
export async function routeCrmProcessing(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(CRM_PROCESSING_PATHS as readonly string[]).includes(request.path)) return null;
  if (options.auth === undefined) return { status: 401, body: redactError('unauthenticated') };
  const verified = await requirePrincipal(options.auth, request);
  if (!verified.ok) return verified.result;
  const scoped = contextForPrincipal(options.auth, verified.principal);
  if (!scoped.ok) return scoped.result;
  if (request.method !== 'POST') return { status: 405, body: redactError('method_not_allowed') };
  if(request.path==='/crm/processing/record/read'){const parsed=crmProcessingRecordReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};const result=await withTransaction(options.auth.db,()=>readCrmProcessingRecord(scoped.context,parsed.data));return result===null?{status:404,body:redactError('not_found')}:{status:200,body:result};}
  if (request.path === '/crm/processing/health/read') {
    const parsed = crmProcessingHealthReadSchema.safeParse(request.body);
    if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
    const result = await withTransaction(options.auth.db, () => readCrmProcessingHealth(scoped.context, parsed.data,options.crmMailEvidence));
    return result === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: result };
  }
  if (request.path === '/crm/processing/purpose/save')
    return runRouteCommand({ auth: options.auth, request, principal: verified.principal }, crmExtractionPurposeSaveSchema,
      'crm.extraction_purpose_saved', (context, body) => saveCrmExtractionPurpose(context, body));
  if (request.path === '/crm/processing/purpose/read') {
    const result = await readCrmExtractionPurpose(scoped.context);
    return result === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: result };
  }
  if (request.path === '/crm/processing/request')
    return runRouteCommand({ auth: options.auth, request, principal: verified.principal }, crmProcessingRequestSchema,
      'crm.processing_requested', (context, body) => requestCrmProcessing(context, body.source,options.crmMailEvidence));
  if (request.path === '/crm/processing/read') {
    const parsed = crmProcessingReadSchema.safeParse(request.body);
    if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
    const result = await withTransaction(options.auth.db, () => readCrmProcessing(scoped.context, parsed.data.source,options.crmMailEvidence));
    return result === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: result };
  }
  const input = crmSourceLookupSchema.safeParse(request.body);
  if (!input.success) return { status: 400, body: redactError('malformed_body') };
  const resolved = await withTransaction(options.auth.db, () => resolveCrmSource(scoped.context, input.data,options.crmMailEvidence));
  return resolved === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: resolved };
}
