import type { RepositoryContext } from '@fss/domain/db';
import { templateContentHash } from '@fss/domain';
import type { OldRecord } from './oldShapes.ts';

/**
 * The template half of the carry: the reader and the manifest are finished, the
 * writer is a named seam (lane G11; specification 2 "Data carry" and 17).
 *
 * "migration of old firms, evidence, suppressions, and unapproved template bodies."
 * The first three land through G3a's and G4's ordinary commands. The fourth cannot:
 * `template_versions` arrives with migration **0009_mail.sql** (lane G7-1, in flight
 * beside this one), migration numbers are the coordinator's to assign, and
 * `loadMigrations` refuses a gap — so this lane may not add the table and may not
 * jump the queue to write into it.
 *
 * What is finished here is everything that does not need the table: the old records
 * are read, counted, hashed into the manifest and turned into the exact rows the
 * writer will insert. What is not is one function, `importTemplateVersions`, which
 * throws rather than pretending. The skipped test in
 * `apps/worker/test/carry/templateSeam.test.ts` is the acceptance it owes.
 *
 * See `docs/decisions/g11-template-importer-seam.md`.
 */

export const CARRY_TEMPLATE_SEAM = Object.freeze({
  migration: '0009_mail.sql',
  table: 'template_versions',
  lane: 'G7-1',
});

export class CarryTemplateSeamError extends Error {
  readonly code = 'template_importer_not_implemented';
  constructor() {
    super(
      `the carry cannot write ${CARRY_TEMPLATE_SEAM.table}: it arrives with migration ${CARRY_TEMPLATE_SEAM.migration}`,
    );
    this.name = 'CarryTemplateSeamError';
  }
}

/**
 * One row of `template_versions`, as migration 0009 defines it: composite key
 * `(workspace_id, id)`, `UNIQUE (workspace_id, template_id, version)`, and approved
 * rows immutable by trigger.
 *
 * Every carried row is **unapproved**. `approved_at` and `approved_by_user_id` are
 * null, which is what section 2's "unapproved template bodies" means and what keeps
 * the immutability trigger out of the carry's way entirely: an unapproved row may
 * still be edited, an approved one may not, and a carry has no authority to approve
 * anything.
 *
 * The old record's postal address is read nowhere and written nowhere. Migration 0015
 * dropped `template_versions.footer_postal_address` under David's 22 September
 * decision (`docs/decisions/g20-automated-email-carries-no-postal-address.md`), so
 * there is no column to carry it into; the old body's own address block, if it has
 * one, travels with the body and has to be edited out before the version is approved
 * here, because the approval refuses a body that does not end with the sign-off and
 * the stop line.
 */
export interface TemplateVersionDraft {
  readonly templateId: string;
  readonly version: number;
  readonly subject: string;
  readonly body: string;
  readonly contentHash: string;
  readonly approvedAt: null;
  readonly approvedByUserId: null;
  readonly retiredAt: null;
}

export interface TemplateCarryCounts {
  readonly created: number;
  readonly reused: number;
  /** Rows the carry read but could not write. Zero once 0009 lands. */
  readonly deferred: number;
}

/**
 * The old templates as the rows the writer will insert.
 *
 * The old record's `revision` becomes the version: it is the number the old core
 * bumped on every edit, so a workspace that edited T1 twice carries version 3 and
 * the uniqueness constraint holds without the carry inventing a numbering.
 *
 * The hash is `templateContentHash` from `@fss/domain` — the same function the send
 * fence and the approval path use — so a carried row's `content_hash` is comparable
 * with one written by an ordinary approval rather than a carry-specific digest.
 */
export function templateVersionDrafts(records: readonly OldRecord[]): readonly TemplateVersionDraft[] {
  return records
    .filter((record): record is Extract<OldRecord, { kind: 'template' }> => record.kind === 'template')
    .map(record => ({
      templateId: record.template.templateId,
      version: record.template.revision,
      subject: record.template.subject,
      body: record.template.body,
      contentHash: templateContentHash({
        templateId: record.template.templateId,
        version: record.template.revision,
        subject: record.template.subject,
        body: record.template.body,
      }),
      approvedAt: null,
      approvedByUserId: null,
      retiredAt: null,
    }));
}

export type TemplateImporter = (
  context: RepositoryContext,
  drafts: readonly TemplateVersionDraft[],
) => Promise<TemplateCarryCounts>;

/**
 * **Unfinished (lane G11).** The one thing this lane owes and did not deliver.
 *
 * When migration 0009 has landed: replace the throw with the scoped insert below,
 * turn `it.skip` into `it` in `apps/worker/test/carry/templateSeam.test.ts`, and
 * delete this paragraph.
 *
 * ```sql
 * INSERT INTO template_versions
 *   (workspace_id, template_id, version, subject, body, content_hash,
 *    approved_at, approved_by_user_id, retired_at)
 * VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL)
 * ON CONFLICT ON CONSTRAINT template_versions_one_per_version DO NOTHING
 * ```
 *
 * The conflict clause is what makes the second run report `reused` rather than
 * failing, exactly as `recordEvidence` does, and `(workspace_id, template_id,
 * version)` is the old item's identity so the idempotency key is the old id as it
 * is for every other kind.
 */
export const importTemplateVersions: TemplateImporter = async () => {
  await Promise.resolve();
  throw new CarryTemplateSeamError();
};

/** The counts a run reports while the seam is open: nothing written, everything read. */
export function deferredTemplateCounts(drafts: readonly TemplateVersionDraft[]): TemplateCarryCounts {
  return { created: 0, reused: 0, deferred: drafts.length };
}
