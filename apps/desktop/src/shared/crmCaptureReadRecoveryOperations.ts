import { crmCaptureReadRecoveryReadSchema, crmCaptureReadRecoveryPayloadSchema, crmCaptureReadRecoveryStatusSchema, crmCaptureReadRecoveryAcknowledgmentSchema, commandIdSchema } from '@fss/contracts';
export const CRM_CAPTURE_READ_RECOVERY_OPERATIONS={
 'crm.captureReadRecoveryRead':{kind:'read',calls:[{method:'POST',path:'/crm/business/capture-read-recovery/read'}],input:crmCaptureReadRecoveryReadSchema,output:crmCaptureReadRecoveryStatusSchema,transform:'Read-only capture recovery status, never provider coverage or sending authority'},
 'crm.captureReadRecoveryRequest':{kind:'command',calls:[{method:'POST',path:'/crm/business/capture-read-recovery/request'}],input:crmCaptureReadRecoveryPayloadSchema.extend({commandId:commandIdSchema}),output:crmCaptureReadRecoveryAcknowledgmentSchema,transform:'One deliberate incident-bound capture-only probe, all holds unchanged'},
} as const;
