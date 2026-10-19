import { z } from 'zod';
import { NATIONAL_DNC_COVERED_AREA_CODES } from '@fss/contracts';
import { reject, sha256, unpackFullArchive } from './archive.ts';

const formats = z.enum(['ftc_full_flat_comma_v1', 'ftc_full_flat_10digit_v1']);
const time = z.iso.datetime({ offset: true });
const codes = z.array(z.string()).length(5).refine(value => [...value].sort().join(',') === NATIONAL_DNC_COVERED_AREA_CODES.join(','));
const reference = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/u);
export const acquisitionManifestSchema = z.strictObject({
  version: z.literal(1), acquisitionId: z.uuid(), receiptReference: reference,
  downloadedAt: time, sourceFormat: formats, downloadKind: z.literal('full'), coveredAreaCodes: codes,
  artifacts: z.array(z.strictObject({ areaCode: z.string(), archivePath: z.string().min(1).max(4096), archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u) })).length(5),
});
/** Recorded privately by the authenticated acquisition owner, not manufactured by parsing. */
export const acquisitionReceiptSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('official_ui_full_download_completed'), acquisitionId: z.uuid(),
  receiptReference: reference, downloadedAt: time, completedAt: time, coveredAreaCodes: codes, sourceFormat: formats,
});
export type AcquisitionManifest = z.infer<typeof acquisitionManifestSchema>;
export interface ArtifactObservation {
  readonly area_code: string; readonly archive_sha256: string; readonly archive_bytes: number;
  readonly uncompressed_sha256: string; readonly uncompressed_bytes: number; readonly record_count: number; readonly crc32: string;
}
export interface RegistryMetadata { readonly version: 1; readonly parser_version: 'national-dnc-full-v1'; readonly artifacts: readonly ArtifactObservation[]; }
const authentic = new WeakSet<ValidatedRegistry>();
export class ValidatedRegistry {
  readonly #members: ReadonlyMap<string, Uint8Array>;
  private constructor(readonly manifest: AcquisitionManifest, readonly completedAt: string, readonly metadata: RegistryMetadata, members: ReadonlyMap<string, Uint8Array>) {
    this.#members = members;
    authentic.add(this);
    Object.freeze(this);
  }
  result(e164: string): 'clear' | 'match' | null {
    if (!/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(e164)) return null;
    const bits = this.#members.get(e164.slice(2, 5));
    if (!bits) return null;
    const n = Number(e164.slice(5));
    return (bits[n >>> 3]! & (1 << (n & 7))) !== 0 ? 'match' : 'clear';
  }
  static async validate(manifestInput: unknown, receiptInput: unknown, readArchive: (path: string) => Promise<Uint8Array>): Promise<ValidatedRegistry> {
    const parsed = acquisitionManifestSchema.safeParse(manifestInput), receipt = acquisitionReceiptSchema.safeParse(receiptInput);
    if (!parsed.success || !receipt.success) reject('acquisition_manifest_invalid');
    const manifest = parsed.data, proof = receipt.data;
    if (proof.acquisitionId !== manifest.acquisitionId || proof.receiptReference !== manifest.receiptReference ||
        proof.downloadedAt !== manifest.downloadedAt || proof.sourceFormat !== manifest.sourceFormat ||
        Date.parse(proof.completedAt) < Date.parse(proof.downloadedAt)) reject('acquisition_receipt_mismatch');
    const actualCodes = manifest.artifacts.map(item => item.areaCode).sort();
    if (actualCodes.join(',') !== NATIONAL_DNC_COVERED_AREA_CODES.join(',') || new Set(manifest.artifacts.map(item => item.archivePath)).size !== 5) reject('acquisition_scope_invalid');
    const members = new Map<string, Uint8Array>(), artifacts: ArtifactObservation[] = [];
    for (const artifact of [...manifest.artifacts].sort((a, b) => a.areaCode.localeCompare(b.areaCode))) {
      const archive = await readArchive(artifact.archivePath);
      if (sha256(archive) !== artifact.archiveSha256) reject('acquisition_digest_mismatch');
      const unpacked = unpackFullArchive(archive);
      const decoded = parseFullFlat(unpacked.bytes, artifact.areaCode, manifest.sourceFormat);
      members.set(artifact.areaCode, decoded.bits);
      artifacts.push(Object.freeze({ area_code: artifact.areaCode, archive_sha256: artifact.archiveSha256, archive_bytes: archive.byteLength,
        uncompressed_sha256: sha256(unpacked.bytes), uncompressed_bytes: unpacked.bytes.byteLength, record_count: decoded.count, crc32: unpacked.crc }));
    }
    Object.freeze(manifest.coveredAreaCodes);
    for (const item of manifest.artifacts) Object.freeze(item);
    Object.freeze(manifest.artifacts);
    Object.freeze(manifest);
    return new ValidatedRegistry(manifest, proof.completedAt, Object.freeze({ version: 1, parser_version: 'national-dnc-full-v1', artifacts: Object.freeze(artifacts) }), members);
  }
}
export function requireValidatedRegistry(value: ValidatedRegistry): void {
  if (!authentic.has(value)) reject('acquisition_not_validated');
}
/** Compact 10-million-bit membership per code: <=6.25MB total, no raw string set. */
export function parseFullFlat(bytes: Uint8Array, areaCode: string, format: z.infer<typeof formats>): { bits: Uint8Array; count: number } {
  const bits = new Uint8Array(1_250_000);
  const comma = format === 'ftc_full_flat_comma_v1';
  if (!comma && format !== 'ftc_full_flat_10digit_v1') reject('flat_format_invalid');
  const width = comma ? 12 : 11;
  if (bytes.length % width !== 0) reject('flat_incomplete');
  let count = 0;
  for (let offset = 0; offset < bytes.length; offset += width) {
    let subscriber = 0;
    if (bytes[offset + width - 1] !== 10 || (comma && bytes[offset + 3] !== 44)) reject('flat_record_invalid');
    for (let i = 0; i < 10; i++) {
      const value = bytes[offset + i + (comma && i >= 3 ? 1 : 0)]! - 48;
      if (value < 0 || value > 9 || ((i === 0 || i === 3) && value < 2)) reject('flat_record_invalid');
      if (i < 3 && value !== Number(areaCode[i])) reject('flat_scope_invalid');
      if (i >= 3) subscriber = subscriber * 10 + value;
    }
    const index = subscriber >>> 3, mask = 1 << (subscriber & 7);
    if ((bits[index]! & mask) !== 0) reject('flat_duplicate_record');
    bits[index] = bits[index]! | mask;
    count++;
  }
  return { bits, count };
}
