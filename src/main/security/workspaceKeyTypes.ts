export type WorkspaceKey = Readonly<{ bytes: Buffer; version: 1 }>;

export type WorkspaceKeyStoreInput = {
  envelopePath: string;
  databaseExists: boolean;
};
