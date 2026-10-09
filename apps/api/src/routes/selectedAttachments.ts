import {selectedAttachmentFileSchema,selectedAttachmentCommitSchema,selectedAttachmentReadSchema,selectedAttachmentAnalyzeSchema} from '@fss/contracts';
import {previewSelectedAttachment,commitSelectedAttachment,readSelectedAttachment,requestSelectedAttachmentAnalysis} from '@fss/domain/crm/selectedAttachments.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const SELECTED_ATTACHMENT_PATHS=['/crm/attachments/preview','/crm/attachments/commit','/crm/attachments/read','/crm/attachments/analyze'] as const;
export async function routeSelectedAttachments(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(SELECTED_ATTACHMENT_PATHS as readonly string[]).includes(request.path))return null;
 if(options.auth===undefined)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 if(request.path==='/crm/attachments/commit')return runRouteCommand({auth:options.auth,request,principal:verified.principal},selectedAttachmentCommitSchema,'crm.selected_attachment_imported',(context,body)=>commitSelectedAttachment(context,body));
 if(request.path==='/crm/attachments/analyze')return runRouteCommand({auth:options.auth,request,principal:verified.principal},selectedAttachmentAnalyzeSchema,'crm.selected_attachment_analysis_requested',(context,body)=>requestSelectedAttachmentAnalysis(context,body));
 if(request.path==='/crm/attachments/read'){const parsed=selectedAttachmentReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};const result=await withTransaction(options.auth.db,()=>readSelectedAttachment(scoped.context,parsed.data.sourceId));return result===null?{status:404,body:redactError('not_found')}:{status:200,body:result};}
 const parsed=selectedAttachmentFileSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
 const result=await previewSelectedAttachment(scoped.context,parsed.data);
 return result===null?{status:404,body:redactError('not_found')}:{status:200,body:result};
}
