import {
  randomBytes as systemRandomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  lstat as nodeLstat,
  open as nodeOpen,
  readFile as nodeReadFile,
  rename as nodeRename,
  rm as nodeRm,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { z } from 'zod';

import type { KeyProtector } from './keyProtector';
import {
  InvalidKeyProtectorResultError,
  InvalidProtectedWorkspaceKeyError,
  WorkspaceKeyEnvelopeCorruptedError,
  WorkspaceKeyTemporarilyUnavailableError,
} from './keyProtector';
import { parseRecoveryKeyMaterial } from './recoveryKey';
import type { WorkspaceKey, WorkspaceKeyStoreInput } from './workspaceKeyTypes';

const WORKSPACE_KEY_BYTE_LENGTH = 32;
const MAX_ENVELOPE_BYTES = 16 * 1024;

type WorkspaceKeyEnvelopeV1 = {
  format: 'callie-workspace-key';
  version: 1;
  protectedKeyBase64: string;
  createdAt: string;
};

type WorkspaceKeyStoreDependencies = {
  fileOperations?: WorkspaceKeyFileOperations;
  keyProtector: KeyProtector;
  parseRecoveryMaterial?: typeof parseRecoveryKeyMaterial;
  randomBytes?: (size: number) => Buffer;
  now?: () => string;
};

export type WorkspaceKeyPathMetadata = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  size: number;
};

export type WorkspaceKeyFileHandle = {
  chmod(mode: number): Promise<void>;
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

export interface WorkspaceKeyFileOperations {
  lstat(path: string): Promise<WorkspaceKeyPathMetadata>;
  open(path: string, flags: 'r' | 'wx', mode?: number): Promise<WorkspaceKeyFileHandle>;
  readFile(path: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export type RestoreWorkspaceKeyInput = {
  envelopePath: string;
  recoveryMaterial: string;
};

const canonicalUtcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const timestamp = new Date(value);
    return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
  });

const canonicalBase64Schema = z.string().min(1).refine((value) => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  try {
    return decoded.toString('base64') === value;
  } finally {
    decoded.fill(0);
  }
});

const workspaceKeyEnvelopeSchema = z.object({
  format: z.literal('callie-workspace-key'),
  version: z.literal(1),
  protectedKeyBase64: canonicalBase64Schema,
  createdAt: canonicalUtcTimestampSchema,
}).strict();

class WorkspaceKeyEnvelopeMissingError extends Error {}

const nodeFileOperations: WorkspaceKeyFileOperations = {
  lstat: nodeLstat,
  open: async (path, flags, mode) => {
    const handle = await nodeOpen(path, flags, mode);
    return {
      chmod: (nextMode) => handle.chmod(nextMode),
      writeFile: (data) => handle.writeFile(data, 'utf8'),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  readFile: (path) => nodeReadFile(path, 'utf8'),
  rename: nodeRename,
  rm: (path) => nodeRm(path, { force: true }),
};

export class WorkspaceKeyUnavailableError extends Error {
  constructor() {
    super('Workspace key is unavailable for an existing database');
    this.name = 'WorkspaceKeyUnavailableError';
  }
}

export class InvalidWorkspaceKeyEnvelopeError extends Error {
  constructor() {
    super('Workspace key envelope is invalid.');
    this.name = 'InvalidWorkspaceKeyEnvelopeError';
  }
}

export class WorkspaceKeyStorageError extends Error {
  constructor() {
    super('Workspace key storage operation failed.');
    this.name = 'WorkspaceKeyStorageError';
  }
}

export class WorkspaceKeyProtectionError extends Error {
  constructor() {
    super('Workspace key protection operation failed.');
    this.name = 'WorkspaceKeyProtectionError';
  }
}

export class WorkspaceKeyStore {
  private readonly fileOperations: WorkspaceKeyFileOperations;
  private readonly parseRecoveryMaterial: typeof parseRecoveryKeyMaterial;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly now: () => string;

  constructor(private readonly dependencies: WorkspaceKeyStoreDependencies) {
    this.fileOperations = dependencies.fileOperations ?? nodeFileOperations;
    this.parseRecoveryMaterial = dependencies.parseRecoveryMaterial ?? parseRecoveryKeyMaterial;
    this.randomBytes = dependencies.randomBytes ?? systemRandomBytes;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async loadOrCreate(input: WorkspaceKeyStoreInput): Promise<WorkspaceKey> {
    assertAbsoluteEnvelopePath(input.envelopePath);
    await assertPrivateDirectory(dirname(input.envelopePath), this.fileOperations);

    let envelope: WorkspaceKeyEnvelopeV1;
    try {
      envelope = await readEnvelope(input.envelopePath, this.fileOperations);
    } catch (error) {
      if (!(error instanceof WorkspaceKeyEnvelopeMissingError)) {
        throw error;
      }
      if (input.databaseExists) {
        throw new WorkspaceKeyUnavailableError();
      }
      return this.create(input.envelopePath);
    }

    return this.load(input.envelopePath, envelope);
  }

  async restore(input: RestoreWorkspaceKeyInput): Promise<WorkspaceKey> {
    assertAbsoluteEnvelopePath(input.envelopePath);
    const recovered = this.parseRecoveryMaterial(input.recoveryMaterial);
    try {
      const createdAt = this.readTimestamp();
      await this.writeProtectedEnvelope(input.envelopePath, recovered.bytes, createdAt);
    } catch (error) {
      recovered.bytes.fill(0);
      throw error;
    }
    return recovered;
  }

  private async create(envelopePath: string): Promise<WorkspaceKey> {
    const generated = this.randomBytes(WORKSPACE_KEY_BYTE_LENGTH);
    if (!Buffer.isBuffer(generated) || generated.byteLength !== WORKSPACE_KEY_BYTE_LENGTH) {
      if (Buffer.isBuffer(generated)) {
        generated.fill(0);
      }
      throw new WorkspaceKeyProtectionError();
    }

    const bytes = Buffer.from(generated);
    generated.fill(0);
    try {
      await this.writeProtectedEnvelope(envelopePath, bytes, this.readTimestamp());
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
    return { bytes, version: 1 };
  }

  private async load(
    envelopePath: string,
    envelope: WorkspaceKeyEnvelopeV1,
  ): Promise<WorkspaceKey> {
    const protectedValue = Buffer.from(envelope.protectedKeyBase64, 'base64');
    let unprotected: { value: Buffer; shouldReprotect: boolean };
    try {
      const protectorResult: unknown = await this.dependencies.keyProtector.unprotect(protectedValue);
      unprotected = parseUnprotectedKeyResult(protectorResult);
    } catch (error) {
      if (
        error instanceof WorkspaceKeyTemporarilyUnavailableError
        || error instanceof InvalidProtectedWorkspaceKeyError
        || error instanceof WorkspaceKeyEnvelopeCorruptedError
        || error instanceof InvalidKeyProtectorResultError
        || error instanceof InvalidWorkspaceKeyEnvelopeError
      ) {
        throw error;
      }
      throw new WorkspaceKeyProtectionError();
    } finally {
      protectedValue.fill(0);
    }

    if (
      !Buffer.isBuffer(unprotected.value)
      || unprotected.value.byteLength !== WORKSPACE_KEY_BYTE_LENGTH
    ) {
      if (Buffer.isBuffer(unprotected.value)) {
        unprotected.value.fill(0);
      }
      throw new InvalidWorkspaceKeyEnvelopeError();
    }

    const bytes = Buffer.from(unprotected.value);
    unprotected.value.fill(0);
    if (unprotected.shouldReprotect) {
      try {
        await this.writeProtectedEnvelope(envelopePath, bytes, envelope.createdAt);
      } catch (error) {
        bytes.fill(0);
        throw error;
      }
    }

    return { bytes, version: 1 };
  }

  private async writeProtectedEnvelope(
    envelopePath: string,
    workspaceKey: Buffer,
    createdAt: string,
  ): Promise<void> {
    const protectionInput = Buffer.from(workspaceKey);
    let protectedValue: Buffer | undefined;
    let protectorResult: unknown;
    try {
      protectorResult = await this.dependencies.keyProtector.protect(protectionInput);
      if (!Buffer.isBuffer(protectorResult) || protectorResult.byteLength === 0) {
        throw new InvalidKeyProtectorResultError();
      }
      if (
        protectorResult.byteLength === workspaceKey.byteLength
        && timingSafeEqual(protectorResult, workspaceKey)
      ) {
        throw new WorkspaceKeyProtectionError();
      }
      protectedValue = Buffer.from(protectorResult);
    } catch (error) {
      if (
        error instanceof WorkspaceKeyTemporarilyUnavailableError
        || error instanceof InvalidKeyProtectorResultError
        || error instanceof WorkspaceKeyProtectionError
      ) {
        throw error;
      }
      throw new WorkspaceKeyProtectionError();
    } finally {
      if (Buffer.isBuffer(protectorResult)) {
        protectorResult.fill(0);
      }
      protectionInput.fill(0);
    }

    try {
      const envelope: WorkspaceKeyEnvelopeV1 = {
        format: 'callie-workspace-key',
        version: 1,
        protectedKeyBase64: protectedValue.toString('base64'),
        createdAt,
      };
      const validatedEnvelope = workspaceKeyEnvelopeSchema.parse(envelope);
      await writeEnvelopeAtomically(envelopePath, validatedEnvelope, this.fileOperations);
    } catch (error) {
      if (error instanceof WorkspaceKeyStorageError) {
        throw error;
      }
      throw new WorkspaceKeyStorageError();
    } finally {
      protectedValue.fill(0);
    }
  }

  private readTimestamp(): string {
    let now: string;
    try {
      now = this.now();
    } catch {
      throw new WorkspaceKeyStorageError();
    }
    const result = canonicalUtcTimestampSchema.safeParse(now);
    if (!result.success) {
      throw new WorkspaceKeyStorageError();
    }
    return result.data;
  }
}

async function readEnvelope(
  envelopePath: string,
  fileOperations: WorkspaceKeyFileOperations,
): Promise<WorkspaceKeyEnvelopeV1> {
  let metadata;
  try {
    metadata = await fileOperations.lstat(envelopePath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new WorkspaceKeyEnvelopeMissingError();
    }
    throw new WorkspaceKeyStorageError();
  }

  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size < 1
    || metadata.size > MAX_ENVELOPE_BYTES
  ) {
    throw new InvalidWorkspaceKeyEnvelopeError();
  }

  let serialized: string;
  try {
    serialized = await fileOperations.readFile(envelopePath);
  } catch {
    throw new WorkspaceKeyStorageError();
  }

  try {
    return workspaceKeyEnvelopeSchema.parse(JSON.parse(serialized) as unknown);
  } catch {
    throw new InvalidWorkspaceKeyEnvelopeError();
  }
}

async function writeEnvelopeAtomically(
  envelopePath: string,
  envelope: WorkspaceKeyEnvelopeV1,
  fileOperations: WorkspaceKeyFileOperations,
): Promise<void> {
  const directory = dirname(envelopePath);
  await assertPrivateDirectory(directory, fileOperations);
  const temporaryPath = join(
    directory,
    `.${basename(envelopePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fileHandle: WorkspaceKeyFileHandle | undefined;
  let renamed = false;

  try {
    fileHandle = await fileOperations.open(temporaryPath, 'wx', 0o600);
    await fileHandle.chmod(0o600);
    await fileHandle.writeFile(JSON.stringify(envelope));
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await fileOperations.rename(temporaryPath, envelopePath);
    renamed = true;

    const directoryHandle = await fileOperations.open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    try {
      await fileHandle?.close();
    } catch {
      // The constant outer error is the only caller-visible failure.
    }
    if (!renamed) {
      try {
        await fileOperations.rm(temporaryPath);
      } catch {
        // The constant outer error is the only caller-visible failure.
      }
    }
    throw new WorkspaceKeyStorageError();
  }
}

async function assertPrivateDirectory(
  directory: string,
  fileOperations: WorkspaceKeyFileOperations,
): Promise<void> {
  try {
    const metadata = await fileOperations.lstat(directory);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (metadata.mode & 0o777) !== 0o700
    ) {
      throw new WorkspaceKeyStorageError();
    }
  } catch (error) {
    if (error instanceof WorkspaceKeyStorageError) {
      throw error;
    }
    throw new WorkspaceKeyStorageError();
  }
}

function parseUnprotectedKeyResult(value: unknown): {
  value: Buffer;
  shouldReprotect: boolean;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidKeyProtectorResultError();
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const resultBuffer = Buffer.isBuffer(record.value) ? record.value : undefined;
  if (
    keys.length !== 2
    || keys[0] !== 'shouldReprotect'
    || keys[1] !== 'value'
    || resultBuffer === undefined
    || typeof record.shouldReprotect !== 'boolean'
  ) {
    resultBuffer?.fill(0);
    throw new InvalidKeyProtectorResultError();
  }

  try {
    return {
      value: Buffer.from(resultBuffer),
      shouldReprotect: record.shouldReprotect,
    };
  } finally {
    resultBuffer.fill(0);
  }
}

function assertAbsoluteEnvelopePath(envelopePath: string): void {
  if (!isAbsolute(envelopePath)) {
    throw new WorkspaceKeyStorageError();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
