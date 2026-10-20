import { describe, expect, it } from 'vitest';
import { crc32, sha256, unpackFullArchive } from '../../dial/nationalRegistry/archive.ts';
import { ValidatedRegistry, parseFullFlat } from '../../dial/nationalRegistry/validate.ts';
import { acquisitionFixture, zipFlat } from './support/registryAcquisition.ts';

describe('full-only explicit FTC flat format and complete ZIP integrity', () => {
  it.each(['ftc_full_flat_comma_v1', 'ftc_full_flat_10digit_v1'] as const)('validates explicit %s, all code artifacts and exact matches', async format => {
    const source = await acquisitionFixture({ format }).validate();
    expect(source.metadata.artifacts).toHaveLength(5);
    expect(source.result('+14015550187')).toBe('match');
    expect(source.result('+14015550188')).toBe('clear');
    expect(source.result('+18175550187')).toBeNull();
    expect(source.result('+442079460123')).toBeNull();
    expect(source.result('+14010550187')).toBeNull();
    expect(Object.isFrozen(source.manifest.artifacts)).toBe(true);
  });
  it.each(['4015550187\n', '401,5550187', '401,5550187\r\n', '\ufeff401,5550187\n', '401,1550187\n', '508,5550187\n', '401,5550187,A\n', '<html>Login</html>\n', '401,5550187\n401,5550187\n'])('rejects malformed, mixed, delta, wrong scope or duplicate row %j', async rows => {
    await expect(acquisitionFixture({ rows: { '401': rows } }).validate()).rejects.toThrow();
  });
  it('does not mix encodings or skip malformed lines and accepts explicitly completed empty full code', async () => {
    expect(parseFullFlat(new Uint8Array(), '401', 'ftc_full_flat_comma_v1').count).toBe(0);
    await expect(acquisitionFixture({ rows: { '401': '401,5550187\n4015550188\n' } }).validate()).rejects.toThrow();
  });
  it('requires matching private official completion receipt and exact subscribed five artifacts', async () => {
    const f = acquisitionFixture();
    await expect(ValidatedRegistry.validate(f.manifest, { ...f.receipt, kind: 'change_list' }, f.read)).rejects.toThrow('acquisition_manifest_invalid');
    await expect(ValidatedRegistry.validate({ ...f.manifest, downloadKind: 'delta' }, f.receipt, f.read)).rejects.toThrow();
    await expect(ValidatedRegistry.validate({ ...f.manifest, artifacts: f.manifest.artifacts.slice(1) }, f.receipt, f.read)).rejects.toThrow();
    await expect(ValidatedRegistry.validate(f.manifest, { ...f.receipt, acquisitionId: crypto.randomUUID() }, f.read)).rejects.toThrow('acquisition_receipt_mismatch');
    const first = f.manifest.artifacts[0]!;
    f.archives.set(first.archivePath, zipFlat('401,5550188\n'));
    await expect(f.validate()).rejects.toThrow('acquisition_digest_mismatch');
  });
  it('validates stored and deflated full member without extracting filenames', () => {
    for (const deflate of [false, true]) expect(unpackFullArchive(zipFlat('401,5550187\n', 'full.txt', deflate)).bytes.toString()).toBe('401,5550187\n');
    expect(crc32(Buffer.from('123456789')).toString(16)).toBe('cbf43926');
  });
  it.each(['../full.txt', '/full.txt', 'nested/full.txt', '..', 'full.zip/'])('rejects unsafe member %j', name => {
    expect(() => unpackFullArchive(zipFlat('401,5550187\n', name))).toThrow();
  });
  it('rejects truncated central directory, CRC mismatch, encryption and expansion claims', () => {
    const original = zipFlat('401,5550187\n');
    expect(() => unpackFullArchive(original.subarray(0, original.length - 1))).toThrow();
    const crc = Buffer.from(original); crc.writeUInt32LE(1, 14);
    expect(() => unpackFullArchive(crc)).toThrow();
    const central = original.readUInt32LE(original.length - 6);
    const encrypted = Buffer.from(original); encrypted.writeUInt16LE(1, central + 8);
    expect(() => unpackFullArchive(encrypted)).toThrow();
    const bomb = Buffer.from(original); bomb.writeUInt32LE(0x7fffffff, central + 24);
    expect(() => unpackFullArchive(bomb)).toThrow('archive_expansion_limit');
    const data = Buffer.from(original); data[30 + Buffer.byteLength('full.txt')]! ^= 1;
    expect(() => unpackFullArchive(data)).toThrow();
    expect(sha256(original)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
