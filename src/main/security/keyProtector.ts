export interface KeyProtector {
  protect(value: Buffer): Promise<Buffer>;
  unprotect(value: Buffer): Promise<{
    value: Buffer;
    shouldReprotect: boolean;
  }>;
}

export class WorkspaceKeyTemporarilyUnavailableError extends Error {
  constructor() {
    super('Workspace key protection is temporarily unavailable.');
    this.name = 'WorkspaceKeyTemporarilyUnavailableError';
  }
}

export class InvalidProtectedWorkspaceKeyError extends Error {
  constructor() {
    super('Protected workspace key is invalid.');
    this.name = 'InvalidProtectedWorkspaceKeyError';
  }
}

export class WorkspaceKeyEnvelopeCorruptedError extends Error {
  constructor() {
    super('Workspace key envelope cannot be decrypted.');
    this.name = 'WorkspaceKeyEnvelopeCorruptedError';
  }
}

export class InvalidKeyProtectorResultError extends Error {
  constructor() {
    super('Workspace key protector returned an invalid result.');
    this.name = 'InvalidKeyProtectorResultError';
  }
}
