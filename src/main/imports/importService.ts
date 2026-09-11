import type {
  ImportCommitReceipt,
  ImportCommitRequest,
  ImportPreview,
  ImportRemapRequest,
  ImportSource,
  ImportStatus,
  ImportStatusRequest,
} from '../../shared/contracts/importContract';

export type ImportProvider = {
  preview(input: ImportSource): Promise<ImportPreview>;
  remap(input: ImportRemapRequest): Promise<ImportPreview>;
  commit(input: ImportCommitRequest): Promise<ImportCommitReceipt>;
  status(input: ImportStatusRequest): Promise<ImportStatus>;
};

/**
 * The import business rules (SHA-256 content hashing, the expiring preview
 * cache, commit revalidation, and preview invalidation after a successful
 * commit) live in the FounderSalesDomain facade. The service is a thin
 * delegate so the IPC seam depends on one narrow provider type.
 */
export type ImportDomain = {
  previewLeadImport(input: ImportSource): ImportPreview;
  remapLeadImport(input: ImportRemapRequest): ImportPreview;
  commitLeadImport(input: ImportCommitRequest): ImportCommitReceipt;
  getImportJob(input: ImportStatusRequest): ImportStatus;
};
