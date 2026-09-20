import { createHash } from 'node:crypto';
import { CARRY_KINDS, type CarryKind, type OldRecord } from './oldShapes.ts';

/**
 * The manifest: per-kind counts and a content hash per item (lane G11;
 * specification 16.1 "Migration rehearsal: watermark, counts, hashes, duplicate
 * reports, suppression parity, template approval state").
 *
 * The hash is over *what the item carries*, not over the bytes it arrived in and not
 * over when it was exported. Two consequences follow, and both are tested.
 *
 * A re-export of an unchanged table produces the same per-item hashes, so parity
 * compares like with like across two runs. The artifact's own digest still changes,
 * because the manifest records when it was made — which is right: the artifact is a
 * different object, and the receipt is what says so.
 *
 * The importer recomputes the hash from the record it is about to write, so parity
 * proves the carried value survived the artifact, not merely that a row exists with
 * the right old id. A count-only check would pass a carry that lost every name.
 */

export const CARRY_MANIFEST_SCHEMA = 'fss.carry.manifest.v1';

export interface ManifestItem {
  readonly kind: CarryKind;
  /** The old item's identifier: the firm id, `firm:<id>`/`handle:<h>`, the template id. */
  readonly oldId: string;
  readonly contentHash: string;
}

export interface ManifestKindSummary {
  readonly count: number;
  /** A digest over this kind's item hashes, in order. One number to read aloud. */
  readonly digest: string;
}

export interface CarryManifest {
  readonly schema: typeof CARRY_MANIFEST_SCHEMA;
  readonly artifactId: string;
  readonly watermarkAt: string;
  readonly createdAt: string;
  readonly kinds: Readonly<Record<CarryKind, ManifestKindSummary>>;
  readonly items: readonly ManifestItem[];
}

/**
 * JSON with object keys in a fixed order, so a hash does not depend on the order a
 * reader happened to build its fields in.
 *
 * `JSON.stringify` preserves insertion order, and the readers in `oldShapes.ts`
 * build their objects consistently — but "consistently" is a property of today's
 * code, and a hash that quietly changed when a field moved would fail parity on a
 * carry that lost nothing. Sorting removes the question.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** The carried payload of one record: everything except where it came from. */
function carriedPayload(record: OldRecord): unknown {
  switch (record.kind) {
    case 'firm':
      return record.firm;
    case 'evidence':
      return record.evidence;
    case 'suppression':
      return record.suppression;
    case 'template':
      return record.template;
  }
}

/**
 * One item's content hash.
 *
 * `shape` is excluded from a firm's digest deliberately: a firm read from `FIRM#`
 * and the same firm read from `ACCOUNT#` are the same firm, and which sort key it
 * was found under is provenance rather than content. Everything else is in.
 */
export function recordContentHash(record: OldRecord): string {
  const payload = carriedPayload(record);
  const content =
    record.kind === 'firm'
      ? (() => {
          const { shape: _shape, ...rest } = payload as Record<string, unknown>;
          return rest;
        })()
      : payload;
  return sha256(canonicalJson({ kind: record.kind, oldId: record.oldId, content }));
}

export interface BuildManifestInput {
  readonly artifactId: string;
  readonly watermarkAt: string;
  readonly createdAt: string;
  readonly records: readonly OldRecord[];
}

/** The items of one manifest, in a fixed order: kind, then old id. */
export function manifestItems(records: readonly OldRecord[]): readonly ManifestItem[] {
  return [...records]
    .map(record => ({ kind: record.kind, oldId: record.oldId, contentHash: recordContentHash(record) }))
    .sort((left, right) =>
      left.kind === right.kind
        ? left.oldId < right.oldId
          ? -1
          : left.oldId > right.oldId
            ? 1
            : 0
        : CARRY_KINDS.indexOf(left.kind) - CARRY_KINDS.indexOf(right.kind),
    );
}

export function buildManifest(input: BuildManifestInput): CarryManifest {
  const items = manifestItems(input.records);
  const kinds = Object.fromEntries(
    CARRY_KINDS.map(kind => {
      const hashes = items.filter(item => item.kind === kind).map(item => item.contentHash);
      return [kind, { count: hashes.length, digest: sha256(hashes.join('\n')) }];
    }),
  ) as Readonly<Record<CarryKind, ManifestKindSummary>>;
  return {
    schema: CARRY_MANIFEST_SCHEMA,
    artifactId: input.artifactId,
    watermarkAt: input.watermarkAt,
    createdAt: input.createdAt,
    kinds,
    items,
  };
}

export function manifestDigest(manifest: CarryManifest): string {
  return sha256(canonicalJson(manifest));
}

export interface ParityKindReport {
  readonly expected: number;
  readonly observed: number;
  readonly missing: number;
  readonly unexpected: number;
  readonly hashMismatches: number;
}

export interface ParityReport {
  readonly matched: boolean;
  readonly perKind: Readonly<Record<CarryKind, ParityKindReport>>;
}

/**
 * The parity check the import fails on (deliverable 2).
 *
 * It compares counts *and* hashes, per kind, and reports every way the two sides can
 * disagree rather than the first one. A run that fails parity should tell David
 * whether three firms are missing or one firm's name changed, because those are
 * different problems with different next steps.
 */
export function compareParity(manifest: CarryManifest, observed: readonly ManifestItem[]): ParityReport {
  const perKind = Object.fromEntries(
    CARRY_KINDS.map(kind => {
      const expectedItems = new Map(manifest.items.filter(item => item.kind === kind).map(item => [item.oldId, item.contentHash]));
      const observedItems = new Map(observed.filter(item => item.kind === kind).map(item => [item.oldId, item.contentHash]));
      let missing = 0;
      let hashMismatches = 0;
      for (const [oldId, hash] of expectedItems) {
        const found = observedItems.get(oldId);
        if (found === undefined) missing += 1;
        else if (found !== hash) hashMismatches += 1;
      }
      let unexpected = 0;
      for (const oldId of observedItems.keys()) if (!expectedItems.has(oldId)) unexpected += 1;
      return [kind, { expected: expectedItems.size, observed: observedItems.size, missing, unexpected, hashMismatches }];
    }),
  ) as Readonly<Record<CarryKind, ParityKindReport>>;

  const matched = CARRY_KINDS.every(kind => {
    const report = perKind[kind];
    return report.missing === 0 && report.unexpected === 0 && report.hashMismatches === 0;
  });
  return { matched, perKind };
}

/** The counts a receipt and a report print. Four numbers, no values. */
export function manifestCounts(manifest: CarryManifest): Readonly<Record<CarryKind, number>> {
  return Object.fromEntries(CARRY_KINDS.map(kind => [kind, manifest.kinds[kind].count])) as Readonly<
    Record<CarryKind, number>
  >;
}
