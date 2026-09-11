import { PHONE_SETUP_ERROR, confirmPhoneSetupSchema, phoneSetupStatusSchema, type PhoneSetupApi } from '../../shared/contracts/phoneSetupContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';

export function registerPhoneSetupIpc(options: {
  provider: PhoneSetupApi; isTrustedRendererUrl?: (url: string) => boolean;
}): () => void {
  const removers: (() => void)[] = [];
  try {
    const shared = { responseSchema: phoneSetupStatusSchema, safeErrorCode: PHONE_SETUP_ERROR,
      isTrustedRendererUrl: options.isTrustedRendererUrl };
    removers.push(registerValidatedIpc({ ...shared, channel: 'phone-setup:status', requestSchema: null,
      handler: () => options.provider.status() }));
    removers.push(registerValidatedIpc({ ...shared, channel: 'phone-setup:confirm', requestSchema: confirmPhoneSetupSchema,
      handler: input => options.provider.confirm(input) }));
    removers.push(registerValidatedIpc({ ...shared, channel: 'phone-setup:clear', requestSchema: null,
      handler: () => options.provider.clear() }));
  } catch (error) { removers.reverse().forEach(remove => remove()); throw error; }
  return () => { for (const remove of removers.splice(0).reverse()) remove(); };
}
