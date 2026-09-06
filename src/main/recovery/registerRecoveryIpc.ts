import {
  RECOVERY_ERROR, beginSetupRequestSchema, completeSetupRequestSchema, recoverySessionSchema,
  recoveryStatusSchema, restoreDrillRequestSchema, restoreDrillResultSchema, saveSetupRequestSchema,
  saveSetupResultSchema, type RecoveryProvider,
} from '../../shared/contracts/recoveryContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';

export function registerRecoveryIpc(provider: RecoveryProvider, isTrustedRendererUrl?: (url: string) => boolean): () => void {
  const common = { isTrustedRendererUrl, safeErrorCode: RECOVERY_ERROR };
  const unregisters = [
    registerValidatedIpc({ ...common, channel: 'recovery:status', requestSchema: null, responseSchema: recoveryStatusSchema, handler: () => provider.status() }),
    registerValidatedIpc({ ...common, channel: 'recovery:begin-setup', requestSchema: beginSetupRequestSchema, responseSchema: recoverySessionSchema, handler: (input) => provider.beginSetup(input) }),
    registerValidatedIpc({ ...common, channel: 'recovery:save-setup-material', requestSchema: saveSetupRequestSchema, responseSchema: saveSetupResultSchema, handler: (input) => provider.saveSetupMaterial(input) }),
    registerValidatedIpc({ ...common, channel: 'recovery:complete-setup', requestSchema: completeSetupRequestSchema, responseSchema: recoveryStatusSchema, handler: (input) => provider.completeSetup(input) }),
    registerValidatedIpc({ ...common, channel: 'recovery:select-and-run-restore-drill', requestSchema: restoreDrillRequestSchema, responseSchema: restoreDrillResultSchema, handler: (input) => provider.selectAndRunRestoreDrill(input) }),
  ];
  return () => { for (const unregister of [...unregisters].reverse()) unregister(); };
}
