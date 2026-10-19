import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const ZIP_LIMITS = { archiveBytes: 32 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024, ratio: 1000 } as const;
export class RegistryImportError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RegistryImportError'; }
}
export function reject(code: string): never { throw new RegistryImportError(code); }
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]!;
  return (value ^ 0xffffffff) >>> 0;
}
function noZip64(extra: Buffer): void {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) reject('archive_extra_invalid');
    const id = extra.readUInt16LE(offset), length = extra.readUInt16LE(offset + 2);
    if (id === 1 || offset + 4 + length > extra.length) reject('archive_extra_invalid');
    offset += 4 + length;
  }
}
/** One regular flat member, stored/deflate only. Validate central/local headers and CRC. */
export function unpackFullArchive(input: Uint8Array): { bytes: Buffer; crc: string } {
  const archive = Buffer.from(input);
  if (archive.length < 22 || archive.length > ZIP_LIMITS.archiveBytes) reject('archive_size_invalid');
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50 || end + 22 + archive.readUInt16LE(end + 20) !== archive.length) reject('archive_incomplete');
  if (archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0 ||
      archive.readUInt16LE(end + 8) !== 1 || archive.readUInt16LE(end + 10) !== 1) reject('archive_scope_invalid');
  const centralSize = archive.readUInt32LE(end + 12), central = archive.readUInt32LE(end + 16);
  if (central + centralSize !== end || central + 46 > end || archive.readUInt32LE(central) !== 0x02014b50) reject('archive_directory_invalid');
  const flags = archive.readUInt16LE(central + 8), method = archive.readUInt16LE(central + 10);
  const crc = archive.readUInt32LE(central + 16), packed = archive.readUInt32LE(central + 20), expanded = archive.readUInt32LE(central + 24);
  const nameLength = archive.readUInt16LE(central + 28), extraLength = archive.readUInt16LE(central + 30), commentLength = archive.readUInt16LE(central + 32);
  const mode = archive.readUInt32LE(central + 38) >>> 16;
  if ((flags & ~0x808) !== 0 || ![0, 8].includes(method) || archive.readUInt16LE(central + 34) !== 0 ||
      (mode & 0xf000) === 0xa000 || ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000) ||
      central + 46 + nameLength + extraLength + commentLength !== end || archive.readUInt32LE(central + 42) !== 0) reject('archive_member_invalid');
  const name = archive.subarray(central + 46, central + 46 + nameLength);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$/u.test(name.toString('ascii')) || name.includes(0) || name.includes(Buffer.from('..'))) reject('archive_member_invalid');
  noZip64(archive.subarray(central + 46 + nameLength, central + 46 + nameLength + extraLength));
  if (expanded > ZIP_LIMITS.expandedBytes || expanded > Math.max(1, packed) * ZIP_LIMITS.ratio) reject('archive_expansion_limit');
  if (central < 30 || archive.readUInt32LE(0) !== 0x04034b50 || archive.readUInt16LE(6) !== flags || archive.readUInt16LE(8) !== method) reject('archive_local_invalid');
  const localName = archive.readUInt16LE(26), localExtra = archive.readUInt16LE(28), start = 30 + localName + localExtra;
  if (localName !== nameLength || start > central || !archive.subarray(30, 30 + localName).equals(name) || start + packed > central) reject('archive_local_invalid');
  noZip64(archive.subarray(30 + localName, start));
  if ((flags & 8) === 0) {
    if (archive.readUInt32LE(14) !== crc || archive.readUInt32LE(18) !== packed || archive.readUInt32LE(22) !== expanded || start + packed !== central) reject('archive_local_invalid');
  } else {
    let descriptor = start + packed;
    if (descriptor + 4 <= central && archive.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
    if (descriptor + 12 !== central || archive.readUInt32LE(descriptor) !== crc || archive.readUInt32LE(descriptor + 4) !== packed || archive.readUInt32LE(descriptor + 8) !== expanded) reject('archive_descriptor_invalid');
  }
  let bytes: Buffer;
  try { bytes = method === 0 ? Buffer.from(archive.subarray(start, start + packed)) : inflateRawSync(archive.subarray(start, start + packed), { maxOutputLength: ZIP_LIMITS.expandedBytes }); }
  catch { return reject('archive_decompression_failed'); }
  if (bytes.length !== expanded || crc32(bytes) !== crc) reject('archive_integrity_failed');
  return { bytes, crc: crc.toString(16).padStart(8, '0') };
}
