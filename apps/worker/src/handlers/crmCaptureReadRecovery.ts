import { runCaptureReadProbe, type CaptureReadProbeDeps } from '@fss/domain/mail/crmCaptureReadProbe.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
export function crmCaptureReadRecoveryHandler(deps?:CaptureReadProbeDeps):JobHandler{return {kind:'crm.capture_read_recovery',protection:'outbound_fence',maxAttempts:1,leaseSeconds:120,handle:input=>runCaptureReadProbe(input,deps)};}
