import { runCaptureReadForward, type CaptureReadForwardDeps } from '@fss/domain/mail/crmCaptureReadForward.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
export function crmCaptureReadForwardHandler(deps?:CaptureReadForwardDeps):JobHandler{return {kind:'crm.capture_read_forward',protection:'outbound_fence',maxAttempts:1,leaseSeconds:120,handle:input=>runCaptureReadForward(input,deps)};}
