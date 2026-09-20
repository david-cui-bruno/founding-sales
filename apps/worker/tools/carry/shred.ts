import { randomBytes } from 'node:crypto';
import { open, stat, unlink } from 'node:fs/promises';
import type { RepositoryContext } from '@fss/domain/db';
import { recordCrmAuditEvent } from '@fss/domain/crm';
import type { CarryReceipt } from './artifact.ts';

/**
 * Deleting the artifact, with the audit row (lane G11, deliverable 3;
 * specification 10.3 and 5.2: "Every deletion and export is audited").
 *
 * This is the runbook's last step and it is deliberately a command rather than an
 * `rm`: a file removed by hand leaves nothing behind that says the carry finished,
 * and "the artifact is gone" is a claim that has to be checkable a year later.
 *
 * ## What the overwrite is, and what it is not
 *
 * The bytes are overwritten with random data and flushed before the file is
 * unlinked. On an SSD with wear levelling, and on APFS with snapshots, that does not
 * guarantee the old blocks are physically unrecoverable, and this tool does not
 * claim it does. What it does guarantee is that the file is gone from the namespace
 * and that no process holding the path can read the plaintext back. The protection
 * that actually matters is upstream: the artifact was never in plaintext on disk,
 * the age identity that could open it lives on removable media, and the runbook has
 * David unmount it.
 *
 * ## The audit row carries numbers, not contents
 *
 * The artifact id, the watermark, the sealed digest, the byte count and the four
 * per-kind counts. No firm name, no handle, no path outside its basename — 5.2:
 * "Audit records exclude secrets and unnecessary message content."
 */

export type ShredRefusal = 'artifact_absent' | 'artifact_still_present' | 'artifact_unlinkable';

export interface ShredOutcome {
  readonly artifactId: string;
  readonly bytesOverwritten: number;
}

export type ShredResult =
  | { readonly ok: true; readonly value: ShredOutcome }
  | { readonly ok: false; readonly reason: ShredRefusal };

/** Overwrite in chunks so a large artifact does not need to fit in memory twice. */
const CHUNK_BYTES = 1024 * 1024;

export async function shredCarryArtifact(
  context: RepositoryContext,
  input: { readonly path: string; readonly receipt: CarryReceipt },
): Promise<ShredResult> {
  let size: number;
  try {
    size = (await stat(input.path)).size;
  } catch {
    return { ok: false, reason: 'artifact_absent' };
  }

  try {
    const handle = await open(input.path, 'r+');
    try {
      for (let written = 0; written < size; written += CHUNK_BYTES) {
        const length = Math.min(CHUNK_BYTES, size - written);
        await handle.write(randomBytes(length), 0, length, written);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await unlink(input.path);
  } catch {
    return { ok: false, reason: 'artifact_unlinkable' };
  }

  // The claim is checked rather than assumed: "gone" is the whole point of the step.
  try {
    await stat(input.path);
    return { ok: false, reason: 'artifact_still_present' };
  } catch {
    // Absent, which is what was wanted.
  }

  await recordCrmAuditEvent(context, {
    action: 'carry.artifact_deleted',
    subjectKind: 'carry_artifact',
    subjectId: input.receipt.artifactId,
    detail: {
      artifactId: input.receipt.artifactId,
      watermarkAt: input.receipt.watermarkAt,
      sealedSha256: input.receipt.sealedSha256,
      sealedBytes: input.receipt.sealedBytes,
      bytesOverwritten: size,
      counts: input.receipt.counts,
      cipher: input.receipt.cipher,
    },
  });

  return { ok: true, value: { artifactId: input.receipt.artifactId, bytesOverwritten: size } };
}
