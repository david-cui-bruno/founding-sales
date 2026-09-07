import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  beginDiscoveryReceiptSchema, beginDiscoveryRequestSchema, discoveryBriefRequestSchema,
  discoveryBriefSchema, discoverySnapshotSchema, overrideDiscoveryRequestSchema,
  type DiscoveryApi,
} from '../../shared/contracts/discoveryContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';

/** Four strict discovery channels. Only successfully registered handlers are owned. */
export function registerDiscoveryIpc({ provider, isTrustedRendererUrl }: {
  provider: DiscoveryApi;
  isTrustedRendererUrl?: (url: string) => boolean;
}): () => void {
  const registrations = [
    () => registerValidatedIpc({ channel: 'discovery:get', requestSchema: null,
      responseSchema: discoverySnapshotSchema,
      handler: async () => {
        const snapshot = discoverySnapshotSchema.parse(await provider.get());
        const ids = [...snapshot.prepared, ...snapshot.judgment].map(brief => brief.personId);
        if (new Set(ids).size !== ids.length) throw new Error('Discovery snapshot contains duplicate Persons.');
        return snapshot;
      }, isTrustedRendererUrl }),
    () => registerValidatedIpc({ channel: 'discovery:get-brief', requestSchema: discoveryBriefRequestSchema,
      responseSchema: discoveryBriefSchema,
      handler: async input => {
        const brief = discoveryBriefSchema.parse(await provider.getBrief(input));
        if (brief.personId !== input.personId) throw new Error('Discovery brief does not match the request.');
        return brief;
      }, isTrustedRendererUrl }),
    () => registerValidatedIpc({ channel: 'discovery:begin', requestSchema: beginDiscoveryRequestSchema,
      responseSchema: beginDiscoveryReceiptSchema,
      handler: async input => {
        const receipt = beginDiscoveryReceiptSchema.parse(await provider.begin(input));
        if (receipt.personId !== input.personId || receipt.salesCycleId !== input.salesCycleId
          || receipt.assessmentId !== input.assessmentId) throw new Error('Discovery receipt does not match the request.');
        return receipt;
      }, isTrustedRendererUrl }),
    () => registerValidatedIpc({ channel: 'discovery:override', requestSchema: overrideDiscoveryRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: async input => {
        const receipt = mutationReceiptSchema.parse(await provider.override(input));
        if (!receipt.affectedPersonIds.includes(input.personId)) throw new Error('Discovery override does not match the request.');
        return receipt;
      }, isTrustedRendererUrl }),
  ];
  const unregisters: (() => void)[] = [];
  const cleanup = (): unknown[] => {
    const errors: unknown[] = [];
    for (const unregister of unregisters.splice(0).reverse()) {
      try { unregister(); } catch (error) { errors.push(error); }
    }
    return errors;
  };
  try {
    for (const register of registrations) unregisters.push(register());
  } catch (error) {
    const errors = cleanup();
    if (errors.length > 0) throw new AggregateError([error, ...errors], 'Discovery IPC registration and rollback failed.', { cause: error });
    throw error;
  }
  return () => {
    const errors = cleanup();
    if (errors.length > 0) throw new AggregateError(errors, 'Discovery IPC cleanup failed.');
  };
}
