import {
  importCommitReceiptSchema,
  importCommitRequestSchema,
  importPreviewSchema,
  importRemapRequestSchema,
  importSourceSchema,
  importStatusRequestSchema,
  importStatusSchema,
  type ImportCommitRequest,
  type ImportRemapRequest,
  type ImportSource,
  type ImportStatusRequest,
} from '../../shared/contracts/importContract';
import type { IpcClient } from '../ipcClient';

export const createImportApi = (client: IpcClient) => ({
  preview: (input: ImportSource) => client.request(
    'imports:preview', importSourceSchema, importPreviewSchema, input,
  ),
  remap: (input: ImportRemapRequest) => client.request(
    'imports:remap', importRemapRequestSchema, importPreviewSchema, input,
  ),
  commit: (input: ImportCommitRequest) => client.request(
    'imports:commit', importCommitRequestSchema, importCommitReceiptSchema, input,
  ),
  status: (input: ImportStatusRequest) => client.request(
    'imports:status', importStatusRequestSchema, importStatusSchema, input,
  ),
});

export type ImportApi = ReturnType<typeof createImportApi>;
