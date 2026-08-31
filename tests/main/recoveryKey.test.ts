import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createRecoveryKeyMaterial,
  InvalidRecoveryKeyChecksumError,
  InvalidRecoveryKeyMaterialError,
  parseRecoveryKeyMaterial,
  UnsupportedRecoveryKeyVersionError,
} from '../../src/main/security/recoveryKey';

describe('workspace recovery material', () => {
  it('formats version 1 material with a canonical base64url key and checksum', () => {
    const material = createRecoveryKeyMaterial({
      bytes: Buffer.alloc(32, 0x2a),
      version: 1,
    });

    expect(material).toBe(
      'CALLIE1-KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio-544e62ce',
    );
  });

  it('parses the canonical material back to an independently owned key', () => {
    const material =
      'CALLIE1-KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio-544e62ce';

    const first = parseRecoveryKeyMaterial(material);
    const second = parseRecoveryKeyMaterial(material);

    expect(first).toEqual({ bytes: Buffer.alloc(32, 0x2a), version: 1 });
    expect(second).toEqual(first);
    expect(second.bytes).not.toBe(first.bytes);
    first.bytes.fill(0);
    expect(second.bytes).toEqual(Buffer.alloc(32, 0x2a));
  });

  it('rejects a checksum mismatch with a constant typed error', () => {
    const operation = () => parseRecoveryKeyMaterial(
      'CALLIE1-KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio-00000000',
    );

    expect(operation).toThrow(InvalidRecoveryKeyChecksumError);
    expect(operation).toThrow('Recovery key checksum is invalid.');
  });

  it('rejects an unsupported explicit version', () => {
    const operation = () => parseRecoveryKeyMaterial(
      'CALLIE2-KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio-544e62ce',
    );

    expect(operation).toThrow(UnsupportedRecoveryKeyVersionError);
    expect(operation).toThrow('Recovery key version is unsupported.');
  });

  it.each([
    '',
    'CALLIE1-not_base64!-544e62ce',
    'CALLIE1-KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio-544E62CE',
    ' CALLIE1-KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio-544e62ce',
  ])('rejects non-canonical material without echoing it: %s', (material) => {
    const operation = () => parseRecoveryKeyMaterial(material);

    expect(operation).toThrow(InvalidRecoveryKeyMaterialError);
    expect(operation).toThrow('Recovery key material is invalid.');
  });

  it('rejects a canonically encoded key whose decoded length is not 32 bytes', () => {
    const shortKey = Buffer.alloc(31, 0x2a);
    const payload = shortKey.toString('base64url');
    const checksum = createHash('sha256').update(shortKey).digest('hex').slice(0, 8);

    expect(() => parseRecoveryKeyMaterial(`CALLIE1-${payload}-${checksum}`)).toThrow(
      InvalidRecoveryKeyMaterialError,
    );
  });

  it('rejects creating recovery material from a non-32-byte key', () => {
    expect(() => createRecoveryKeyMaterial({ bytes: Buffer.alloc(31), version: 1 })).toThrow(
      'Workspace key must contain exactly 32 bytes.',
    );
  });
});
