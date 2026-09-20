import { sealArtifact, type ArtifactCipher, type CarryReceipt } from './artifact.ts';
import type { OldTableReader } from './dynamoPort.ts';
import { buildManifest, type CarryManifest } from './manifest.ts';
import { CARRY_KINDS, OLD_PREFIXES, readOldRecord, type CarryKind, type OldRecord } from './oldShapes.ts';
import { isAfterWatermark, readWatermark, type WatermarkRefusal } from './watermark.ts';

/**
 * The export (lane G11, deliverable 1; specification 2 "Data carry", 17, Appendix
 * G 20).
 *
 * One pass over the old table under the watermark, one sealed artifact, one receipt.
 * The export is the last cheap place to say no: afterwards an artifact of prospect
 * data exists on a disk and somebody has to shred it. So every refusal lives here,
 * none of them has an override, and the export writes nothing at all when it refuses.
 *
 * ## The order the prefixes are read, and why `ACCOUNT#` is second
 *
 * `FIRM#` first, `ACCOUNT#` second. A firm with both records is carried once, from
 * its `FIRM#` record — which is how the old copy itself read them, and which is right
 * because the `FIRM#` record is the newer shape and carries the routes David admitted
 * by hand. `ACCOUNT#` is read only to find the firms that never got one.
 *
 * ## What a refusal may say
 *
 * Counts, per kind. Never a sort key, a firm id, a handle or a name: a refusal is
 * printed to a terminal and pasted into a message, and an operational message about
 * a carry is not a place for a prospect's number. `apps/worker/test/carry/export.test.ts`
 * asserts it.
 */

export type ExportRefusal = WatermarkRefusal | 'record_unreadable' | 'post_watermark_items_present';

export interface CarryExportValue {
  readonly manifest: CarryManifest;
  readonly receipt: CarryReceipt;
  readonly sealed: Buffer;
}

export type CarryExportResult =
  | { readonly ok: true; readonly value: CarryExportValue }
  | {
      readonly ok: false;
      readonly reason: ExportRefusal;
      /** Per-kind counts of whatever caused the refusal. Numbers only. */
      readonly detail: Readonly<Partial<Record<CarryKind, number>>>;
    };

export interface CarryExportInput {
  readonly reader: OldTableReader;
  /** The contents of the watermark flag file, or null when there is no file. */
  readonly watermarkFlag: string | null;
  readonly cipher: ArtifactCipher;
  readonly now: Date;
  readonly artifactId: string;
}

/** The prefixes queried, in order. `SUPPRESS#` covers both suppression scopes. */
const PREFIX_ORDER = [
  OLD_PREFIXES.firm,
  OLD_PREFIXES.account,
  OLD_PREFIXES.evidence,
  OLD_PREFIXES.suppression,
  OLD_PREFIXES.template,
] as const;

function tally(counts: Partial<Record<CarryKind, number>>, kind: CarryKind | null): void {
  if (kind === null) return;
  counts[kind] = (counts[kind] ?? 0) + 1;
}

export async function runCarryExport(input: CarryExportInput): Promise<CarryExportResult> {
  const watermark = readWatermark(input.watermarkFlag, input.now);
  if (!watermark.ok) return { ok: false, reason: watermark.reason, detail: {} };

  const unreadable: Partial<Record<CarryKind, number>> = {};
  const postWatermark: Partial<Record<CarryKind, number>> = {};
  const records: OldRecord[] = [];
  const carriedFirmIds = new Set<string>();

  for (const prefix of PREFIX_ORDER) {
    for (const item of await input.reader.listByPrefix(prefix)) {
      // `SUPPRESS#` and `SUPPRESS#FIRM#` share a query; `FIRM#` and `ACCOUNT#` do not
      // overlap. Nothing else can arrive under a prefix it does not belong to.
      const read = readOldRecord(item);
      if (!read.ok) {
        if (read.reason === 'sk_unknown') continue;
        tally(unreadable, read.kind);
        continue;
      }
      const record = read.value;
      if (isAfterWatermark(record.recordedAt, watermark.value.disabledAt)) {
        tally(postWatermark, record.kind);
        continue;
      }
      if (record.kind === 'firm') {
        // The FIRM# pass runs first, so an ACCOUNT# row for a firm already carried is
        // the same firm in an older shape and is not carried twice.
        if (carriedFirmIds.has(record.oldId)) continue;
        carriedFirmIds.add(record.oldId);
      }
      records.push(record);
    }
  }

  // Both refusals are reported before either is acted on, so a run with an
  // unreadable record *and* a post-watermark write is not fixed twice.
  if (Object.keys(unreadable).length > 0) return { ok: false, reason: 'record_unreadable', detail: unreadable };
  if (Object.keys(postWatermark).length > 0) {
    return { ok: false, reason: 'post_watermark_items_present', detail: postWatermark };
  }

  const manifest = buildManifest({
    artifactId: input.artifactId,
    watermarkAt: watermark.value.disabledAt,
    createdAt: input.now.toISOString(),
    records,
  });
  const sealed = await sealArtifact({ manifest, records, cipher: input.cipher });
  return { ok: true, value: { manifest, receipt: sealed.receipt, sealed: sealed.sealed } };
}

/** The export's report, as the CLI prints it: counts and digests, never a value. */
export function exportReport(value: CarryExportValue): string {
  const lines = [
    `artifact      ${value.receipt.artifactId}`,
    `watermark     ${value.receipt.watermarkAt}`,
    `created       ${value.receipt.createdAt}`,
    `cipher        ${value.receipt.cipher}`,
    `sealed bytes  ${String(value.receipt.sealedBytes)}`,
    `sealed sha256 ${value.receipt.sealedSha256}`,
    `manifest      ${value.receipt.manifestDigest}`,
  ];
  for (const kind of CARRY_KINDS) {
    lines.push(`${kind.padEnd(13)} ${String(value.manifest.kinds[kind].count)}  ${value.manifest.kinds[kind].digest}`);
  }
  return lines.join('\n');
}
