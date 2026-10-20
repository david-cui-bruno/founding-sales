import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { NATIONAL_DNC_COVERED_AREA_CODES } from '@fss/contracts';
import { crc32, sha256 } from '../../../dial/nationalRegistry/archive.ts';
import { ValidatedRegistry, type AcquisitionManifest } from '../../../dial/nationalRegistry/validate.ts';

export function zipFlat(text: string | Buffer, name = 'full.txt', deflate = true): Buffer {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text), filename = Buffer.from(name);
  const compressed = deflate ? deflateRawSync(bytes) : bytes;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
  const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(deflate ? 8 : 0, 10);
  directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28);
  const central = Buffer.concat([directory, filename]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, end]);
}
export function acquisitionFixture(options: { downloadedAt?: string; rows?: Readonly<Record<string,string>>; format?: AcquisitionManifest['sourceFormat']; acquisitionId?: string } = {}) {
  const archives = new Map<string, Buffer>();
  const downloadedAt = options.downloadedAt ?? new Date(Date.now() - 60000).toISOString();
  const sourceFormat = options.format ?? 'ftc_full_flat_comma_v1';
  const manifest: AcquisitionManifest = { version: 1, acquisitionId: options.acquisitionId ?? randomUUID(), receiptReference: `test_download_${randomUUID()}`,
    downloadedAt, sourceFormat, downloadKind: 'full', coveredAreaCodes: [...NATIONAL_DNC_COVERED_AREA_CODES],
    artifacts: NATIONAL_DNC_COVERED_AREA_CODES.map(areaCode => {
      const row = options.rows?.[areaCode] ?? (sourceFormat === 'ftc_full_flat_comma_v1' ? `${areaCode},5550187\n` : `${areaCode}5550187\n`);
      const archive = zipFlat(row), archivePath = `/fixture/${areaCode}.zip`; archives.set(archivePath, archive);
      return { areaCode, archivePath, archiveSha256: sha256(archive) };
    }) };
  const receipt = { version: 1, kind: 'official_ui_full_download_completed', acquisitionId: manifest.acquisitionId,
    receiptReference: manifest.receiptReference, downloadedAt, completedAt: downloadedAt, coveredAreaCodes: [...NATIONAL_DNC_COVERED_AREA_CODES], sourceFormat };
  const read = async (path: string) => { const bytes = archives.get(path); if (!bytes) throw new Error('fixture missing'); return bytes; };
  const validate = async () => await ValidatedRegistry.validate(manifest, receipt, read);
  return { manifest, receipt, archives, read, validate };
}
