import type { RepositoryContext } from '@fss/domain/db';
import {
  addEmailRoute,
  addPhoneRoute,
  createFirm,
  recordEvidence,
  recordCrmAuditEvent,
  resolveZoneForFirm,
} from '@fss/domain/crm';
import { recordSuppression, type SuppressionJournal } from '@fss/domain/suppression';
import { openArtifact } from './artifact.ts';
import { compareParity, recordContentHash, type CarryManifest, type ManifestItem, type ParityReport } from './manifest.ts';
import { CARRY_KINDS, type CarryKind, type OldRecord } from './oldShapes.ts';
import {
  deferredTemplateCounts,
  templateVersionDrafts,
  type TemplateCarryCounts,
  type TemplateImporter,
} from './templates.ts';
import { isAfterWatermark } from './watermark.ts';

/**
 * The import (lane G11, deliverable 2; specification 2 "Data carry", 17, Appendix
 * A "Import batch", Appendix G 8 and 20).
 *
 * ## Everything goes through the ordinary commands
 *
 * `createFirm`, `resolveZoneForFirm`, `addPhoneRoute`, `addEmailRoute`,
 * `recordEvidence` and `recordSuppression` — the same functions the API's own routes
 * call, with the same authorization, the same audit events, the same route-eligibility
 * policy and the same journal-before-row ordering. `packages/domain/crm/import.ts`
 * says why for the CSV importer and the same sentence applies here: an importer that
 * wrote rows directly would be a second CRM with none of the rules, and the first
 * thing it would lose is that eligibility is the policy's decision — a carried phone
 * number arrives as a `candidate`, never as something dialable.
 *
 * ## Idempotent by the old item id
 *
 * Each kind carries its old identity into the row it writes, and re-running the
 * import finds it there:
 *
 * | Kind | The old id, in the greenfield row | What makes the second run a no-op |
 * |---|---|---|
 * | firm | `record_aliases (alias_kind = 'external_id')` | the alias is looked up first |
 * | evidence | `evidence_items.content_hash`, per source | `evidence_items_one_per_result` |
 * | suppression | the deterministic event id, derived from `carry:<old sk>` | `readSuppressionEvent` |
 * | template | `(workspace_id, template_id, version)` | deferred; see `templates.ts` |
 *
 * Every one of those lookups is workspace-scoped, which is what Appendix G 8 needs:
 * the same artifact imported into two workspaces creates two sets of firms with the
 * same old ids and neither can see the other.
 *
 * ## The transaction is the caller's
 *
 * `runCarryImport` does not `BEGIN`. The caller wraps it in one transaction, so a
 * parity failure rolls the whole carry back and the next attempt starts from a clean
 * database rather than from a half-finished one. The suppression journal is the one
 * write that survives a rollback, and 10.2 calls that the safe direction: replay
 * re-inserts the event and a suppression is only ever conservatively retained.
 */

export { openArtifact as openCarryArtifact };

export interface KindCounts {
  readonly created: number;
  readonly reused: number;
}

export interface CarryImportReport {
  readonly artifactId: string;
  readonly watermarkAt: string;
  readonly carried: {
    readonly firm: KindCounts;
    readonly evidence: KindCounts;
    readonly suppression: KindCounts;
    readonly template: TemplateCarryCounts;
  };
  /** Routes carried alongside their firms. Not a manifest kind; a firm's own data. */
  readonly routes: KindCounts;
  readonly parity: ParityReport;
}

export type ImportRefusal =
  | 'post_watermark_record'
  | 'parity_mismatch'
  | 'firm_refused'
  | 'evidence_refused'
  | 'suppression_refused'
  | 'suppression_firm_absent'
  | 'template_refused';

export type CarryImportResult =
  | { readonly ok: true; readonly value: CarryImportReport }
  | {
      readonly ok: false;
      readonly reason: ImportRefusal;
      /** Codes and counts. Never a firm name, a handle or an address. */
      readonly detail: Readonly<Record<string, unknown>>;
    };

export interface CarryImportInput {
  readonly manifest: CarryManifest;
  readonly records: readonly OldRecord[];
  readonly journal: SuppressionJournal;
  /** Supplied once migration 0009 exists. Until then the templates are deferred. */
  readonly templateImporter?: TemplateImporter | undefined;
}

/** The command id a carried suppression asserts under. Deterministic, so a replay matches. */
export function carryCommandId(record: OldRecord): string {
  return `carry:${record.sk}`;
}

/** The firm this workspace already carries under that old id, or null. */
async function findCarriedFirm(context: RepositoryContext, oldFirmId: string): Promise<string | null> {
  const { rows } = await context.db.query<{ firm_id: string }>(
    `SELECT firm_id FROM record_aliases
      WHERE workspace_id = $1 AND record_kind = 'firm' AND alias_kind = 'external_id' AND alias_value = $2
      LIMIT 1`,
    [context.scope.workspaceId, oldFirmId],
  );
  return rows[0]?.firm_id ?? null;
}

export async function runCarryImport(
  context: RepositoryContext,
  input: CarryImportInput,
): Promise<CarryImportResult> {
  // Appendix G 20's carry half. The manifest names the watermark the export ran
  // under; a record after it never flows into the new stack, whatever the artifact
  // says about itself.
  for (const record of input.records) {
    if (isAfterWatermark(record.recordedAt, input.manifest.watermarkAt)) {
      return { ok: false, reason: 'post_watermark_record', detail: { kind: record.kind } };
    }
  }

  const observed: ManifestItem[] = [];
  const firm: { created: number; reused: number } = { created: 0, reused: 0 };
  const evidence = { created: 0, reused: 0 };
  const suppression = { created: 0, reused: 0 };
  const routes = { created: 0, reused: 0 };
  const firmIdByOldId = new Map<string, string>();

  const ordered = [...input.records].sort(
    (left, right) => CARRY_KINDS.indexOf(left.kind) - CARRY_KINDS.indexOf(right.kind),
  );

  for (const record of ordered) {
    switch (record.kind) {
      case 'firm': {
        const existing = await findCarriedFirm(context, record.firm.firmId);
        if (existing !== null) {
          firmIdByOldId.set(record.firm.firmId, existing);
          firm.reused += 1;
        } else {
          const created = await createFirm(context, {
            name: record.firm.name,
            ...(record.firm.website === null ? {} : { website: record.firm.website }),
            ...(record.firm.locality === null ? {} : { locality: record.firm.locality }),
            ...(record.firm.regionCode === null ? {} : { regionCode: record.firm.regionCode }),
            externalId: record.firm.firmId,
          });
          if (!created.ok) return { ok: false, reason: 'firm_refused', detail: { code: created.reason } };
          firmIdByOldId.set(record.firm.firmId, created.value.id);
          firm.created += 1;

          // Section 9.2: the zone comes from the versioned source rule over the
          // firm's own location, never from the old record's state-wide guess. A
          // multi-zone state with no postal code stays unresolved, which blocks
          // calling — `zone_unresolved` is a recorded fact, not a failure.
          await resolveZoneForFirm(context, { firmId: created.value.id });
        }

        const firmId = firmIdByOldId.get(record.firm.firmId);
        if (firmId === undefined) return { ok: false, reason: 'firm_refused', detail: { code: 'firm_unknown' } };
        for (const route of record.firm.routes) {
          // `source: 'import'` is what the route records about where it came from,
          // and it is why `decideRouteEligibility` leaves these as candidates: the
          // old table has neither technical validation nor association confidence.
          const added =
            route.channel === 'email'
              ? await addEmailRoute(context, { firmId, address: route.value, source: 'import' })
              : await addPhoneRoute(context, { firmId, e164: route.value, source: 'import' });
          if (!added.ok) {
            // A route the greenfield validators refuse is not a reason to lose the
            // firm: it is reported and the firm is carried without it. A route is
            // recoverable by hand; a firm dropped from the carry is not.
            routes.reused += 1;
            continue;
          }
          routes.created += 1;
        }
        observed.push({ kind: 'firm', oldId: record.oldId, contentHash: recordContentHash(record) });
        break;
      }

      case 'evidence': {
        const firmId = firmIdByOldId.get(record.evidence.firmId) ?? (await findCarriedFirm(context, record.evidence.firmId));
        if (firmId === null || firmId === undefined) {
          return { ok: false, reason: 'evidence_refused', detail: { code: 'firm_unknown' } };
        }
        // One old `EVIDENCE#` record is one manifest item however many sources it
        // holds, so whether this run created it is decided once, before the writes,
        // from whether any of its rows are already here.
        const alreadyCarried = await evidenceAlreadyCarried(context, firmId, record.sk);
        for (const source of record.evidence.sources) {
          const recorded = await recordEvidence(context, {
            firmId,
            // The old table names no provider per source; it names the pages it
            // fetched. `legacy_research` is the honest word for "the research the
            // old core did", and inventing a provider name would be a citation the
            // record cannot support.
            provider: 'legacy_research',
            sourceReference: source.url,
            contentHash: source.sha256,
            retrievedAt: new Date(source.fetchedAt),
            detail: { carriedFrom: record.sk, sourceId: source.sourceId, excerpt: source.excerpt },
          });
          if (!recorded.ok) return { ok: false, reason: 'evidence_refused', detail: { code: recorded.reason } };
        }
        if (alreadyCarried > 0) evidence.reused += 1;
        else evidence.created += 1;
        observed.push({ kind: 'evidence', oldId: record.oldId, contentHash: recordContentHash(record) });
        break;
      }

      case 'suppression': {
        const commandId = carryCommandId(record);
        if (record.suppression.scope === 'firm') {
          const firmId =
            firmIdByOldId.get(record.suppression.firmId) ?? (await findCarriedFirm(context, record.suppression.firmId));
          if (firmId === null || firmId === undefined) {
            // Invariant 4. A suppression whose firm did not come over is never
            // dropped: the run fails and David finds out why the firm is missing.
            return { ok: false, reason: 'suppression_firm_absent', detail: { scope: 'firm' } };
          }
          const recorded = await recordSuppression(context, {
            scope: 'firm',
            firmId,
            source: 'import',
            commandId,
            journal: input.journal,
          });
          if (!recorded.ok) return { ok: false, reason: 'suppression_refused', detail: { code: recorded.reason } };
          if (recorded.value.replayed) suppression.reused += 1;
          else suppression.created += 1;
        } else {
          const recorded = await recordSuppression(context, {
            scope: 'handle',
            value: record.suppression.handle,
            source: 'import',
            commandId,
            journal: input.journal,
          });
          if (!recorded.ok) return { ok: false, reason: 'suppression_refused', detail: { code: recorded.reason } };
          if (recorded.value.replayed) suppression.reused += 1;
          else suppression.created += 1;
        }
        observed.push({ kind: 'suppression', oldId: record.oldId, contentHash: recordContentHash(record) });
        break;
      }

      case 'template': {
        observed.push({ kind: 'template', oldId: record.oldId, contentHash: recordContentHash(record) });
        break;
      }
    }
  }

  const drafts = templateVersionDrafts(input.records);
  let template: TemplateCarryCounts = deferredTemplateCounts(drafts);
  if (input.templateImporter !== undefined) {
    try {
      template = await input.templateImporter(context, drafts);
    } catch (error) {
      return {
        ok: false,
        reason: 'template_refused',
        detail: { code: error instanceof Error ? error.name : 'unknown' },
      };
    }
  }

  const parity = compareParity(input.manifest, observed);
  if (!parity.matched) return { ok: false, reason: 'parity_mismatch', detail: { perKind: parity.perKind } };

  await recordCrmAuditEvent(context, {
    action: 'carry.imported',
    subjectKind: 'carry_artifact',
    subjectId: input.manifest.artifactId,
    detail: {
      watermarkAt: input.manifest.watermarkAt,
      createdAt: input.manifest.createdAt,
      counts: Object.fromEntries(CARRY_KINDS.map(kind => [kind, input.manifest.kinds[kind].count])),
      carried: { firm, evidence, suppression, template, routes },
      parityMatched: parity.matched,
    },
  });

  return {
    ok: true,
    value: {
      artifactId: input.manifest.artifactId,
      watermarkAt: input.manifest.watermarkAt,
      carried: { firm, evidence, suppression, template },
      routes,
      parity,
    },
  };
}

/** How many evidence rows this old record has already produced for this firm. */
async function evidenceAlreadyCarried(context: RepositoryContext, firmId: string, oldSk: string): Promise<number> {
  const { rows } = await context.db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM evidence_items
      WHERE workspace_id = $1 AND firm_id = $2 AND provider = 'legacy_research' AND detail->>'carriedFrom' = $3`,
    [context.scope.workspaceId, firmId, oldSk],
  );
  return Number(rows[0]?.count ?? '0');
}

/** The import's report, as the CLI prints it. Counts only. */
export function importReport(report: CarryImportReport): string {
  const lines = [
    `artifact   ${report.artifactId}`,
    `watermark  ${report.watermarkAt}`,
    `firms      created ${String(report.carried.firm.created)}  reused ${String(report.carried.firm.reused)}`,
    `evidence   created ${String(report.carried.evidence.created)}  reused ${String(report.carried.evidence.reused)}`,
    `routes     created ${String(report.routes.created)}  refused ${String(report.routes.reused)}`,
    `suppress   created ${String(report.carried.suppression.created)}  reused ${String(report.carried.suppression.reused)}`,
    `templates  created ${String(report.carried.template.created)}  deferred ${String(report.carried.template.deferred)}`,
    `parity     ${report.parity.matched ? 'matched' : 'MISMATCH'}`,
  ];
  for (const kind of CARRY_KINDS) {
    const entry = report.parity.perKind[kind as CarryKind];
    lines.push(
      `  ${kind.padEnd(12)} expected ${String(entry.expected)} observed ${String(entry.observed)} ` +
        `missing ${String(entry.missing)} unexpected ${String(entry.unexpected)} hash-mismatch ${String(entry.hashMismatches)}`,
    );
  }
  return lines.join('\n');
}
