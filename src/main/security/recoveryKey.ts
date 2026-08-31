import { createHash, timingSafeEqual } from 'node:crypto';

import type { WorkspaceKey } from './workspaceKeyTypes';

const RECOVERY_PREFIX = 'CALLIE';
const RECOVERY_VERSION = 1;
const WORKSPACE_KEY_BYTE_LENGTH = 32;
const CHECKSUM_HEX_LENGTH = 8;

export class InvalidRecoveryKeyMaterialError extends Error {
  constructor() {
    super('Recovery key material is invalid.');
    this.name = 'InvalidRecoveryKeyMaterialError';
  }
}

export class InvalidRecoveryKeyChecksumError extends Error {
  constructor() {
    super('Recovery key checksum is invalid.');
    this.name = 'InvalidRecoveryKeyChecksumError';
  }
}

export class UnsupportedRecoveryKeyVersionError extends Error {
  constructor() {
    super('Recovery key version is unsupported.');
    this.name = 'UnsupportedRecoveryKeyVersionError';
  }
}

export function createRecoveryKeyMaterial(key: WorkspaceKey): string {
  assertWorkspaceKey(key);
  const encodedKey = key.bytes.toString('base64url');
  const checksum = calculateChecksum(key.bytes).toString('hex');
  return `${RECOVERY_PREFIX}${RECOVERY_VERSION}-${encodedKey}-${checksum}`;
}

export function parseRecoveryKeyMaterial(material: string): WorkspaceKey {
  const versionMatch = /^CALLIE(\d+)-/.exec(material);
  if (versionMatch !== null && versionMatch[1] !== String(RECOVERY_VERSION)) {
    throw new UnsupportedRecoveryKeyVersionError();
  }

  const match = /^CALLIE1-([A-Za-z0-9_-]{43})-([0-9a-f]{8})$/.exec(material);
  if (match === null) {
    throw new InvalidRecoveryKeyMaterialError();
  }

  const encodedKey = match[1];
  const suppliedChecksum = Buffer.from(match[2], 'hex');
  const bytes = Buffer.from(encodedKey, 'base64url');
  if (
    bytes.byteLength !== WORKSPACE_KEY_BYTE_LENGTH
    || bytes.toString('base64url') !== encodedKey
  ) {
    bytes.fill(0);
    throw new InvalidRecoveryKeyMaterialError();
  }

  const expectedChecksum = calculateChecksum(bytes);
  const checksumMatches = suppliedChecksum.byteLength === expectedChecksum.byteLength
    && timingSafeEqual(suppliedChecksum, expectedChecksum);
  suppliedChecksum.fill(0);
  expectedChecksum.fill(0);
  if (!checksumMatches) {
    bytes.fill(0);
    throw new InvalidRecoveryKeyChecksumError();
  }

  return { bytes, version: 1 };
}

function calculateChecksum(value: Buffer): Buffer {
  return createHash('sha256').update(value).digest().subarray(0, CHECKSUM_HEX_LENGTH / 2);
}

function assertWorkspaceKey(key: WorkspaceKey): void {
  if (
    key.version !== RECOVERY_VERSION
    || !Buffer.isBuffer(key.bytes)
    || key.bytes.byteLength !== WORKSPACE_KEY_BYTE_LENGTH
  ) {
    throw new RangeError('Workspace key must contain exactly 32 bytes.');
  }
}
