import {z} from 'zod';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {materializeNativeCrmExtraction} from '@fss/domain/crm/processingCapture.ts';
const payloadSchema=z.strictObject({source:z.strictObject({workspaceId:z.string().uuid(),sourceId:z.string().uuid(),kind:z.enum(['call_transcript','meeting_transcript']),revision:z.number().int().positive(),contentHash:z.string().regex(/^[a-f0-9]{64}$/u),locator:z.null()}),ownerUserId:z.string().uuid(),originalFirmId:z.string().uuid(),contextHash:z.string().regex(/^[a-f0-9]{64}$/u),purposeRevision:z.number().int().positive()});
/** Provider-free successor; capture and this intent commit or roll back together. */
export function crmCaptureExtractionJobHandler():JobHandler{return {kind:'crm.capture_extraction',protection:'business_uniqueness',maxAttempts:3,leaseSeconds:60,handle:async input=>{const parsed=payloadSchema.safeParse(input.job.payload);if(!parsed.success||parsed.data.source.workspaceId!==input.scope.workspaceId)return;await materializeNativeCrmExtraction(repositoryContext(input.scope,input.session),parsed.data);}};}
