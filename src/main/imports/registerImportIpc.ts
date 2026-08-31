import {
  importCommitReceiptSchema,
  importCommitRequestSchema,
  importPreviewSchema,
  importRemapRequestSchema,
  importSourceSchema,
  importStatusRequestSchema,
  importStatusSchema,
} from '../../shared/contracts/importContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { ImportProvider } from './importService';

export const IMPORT_IPC_CHANNELS = {
  preview: 'imports:preview',
  remap: 'imports:remap',
  commit: 'imports:commit',
  status: 'imports:status',
} as const;

export function registerImportIpc(
  provider: ImportProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisters = [
    registerValidatedIpc({
      channel: IMPORT_IPC_CHANNELS.preview,
      requestSchema: importSourceSchema,
      responseSchema: importPreviewSchema,
      handler: (request) => provider.preview(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: IMPORT_IPC_CHANNELS.remap,
      requestSchema: importRemapRequestSchema,
      responseSchema: importPreviewSchema,
      handler: (request) => provider.remap(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: IMPORT_IPC_CHANNELS.commit,
      requestSchema: importCommitRequestSchema,
      responseSchema: importCommitReceiptSchema,
      handler: (request) => provider.commit(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: IMPORT_IPC_CHANNELS.status,
      requestSchema: importStatusRequestSchema,
      responseSchema: importStatusSchema,
      handler: (request) => provider.status(request),
      isTrustedRendererUrl,
    }),
  ];

  let registered = true;

  return () => {
    if (!registered) {
      return;
    }

    registered = false;
    for (const unregister of unregisters) {
      unregister();
    }
  };
}
