import { readAppliedSchemaVersion } from '@fss/domain/db/migrationRunner.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import {
  composeSendBody,
  sendBodyIssue,
  SENT_BODY_MAX_LENGTH,
} from '@fss/domain/src/rules/templates.ts';
import { POSTAL_ADDRESS_MAX_LENGTH } from '@fss/contracts';
import type { AdminInvocation, AdminOutcome } from './admin.ts';

/**
 * `fss admin schema-preflight 0020`: what the postal-address release will meet, counted
 * before it stops anything (lane W3-F).
 *
 * `packages/domain/db/migrations/0020_postal_address.sql` is additive: it widens
 * `workspace_settings_key_known` to admit `postal_address` and changes nothing else. So
 * the interesting question is not what the migration destroys — it destroys nothing —
 * but what the *release* changes: from schema 20 the footer is composed at send, so every
 * unsent fence's body is recomposed under the claim lock and every template's legacy
 * footer block is deduped at composition.
 *
 * This counts all of that, read-only, while both services are still running:
 *
 *   * the settings rows by key, every version and the current one, so the coordinator can
 *     see the table the CHECK is about to be replaced over;
 *   * the `prepared` and `held` fences, split into the ones already carrying exactly the
 *     bytes the new code composes and the ones that will be rewritten;
 *   * the template versions whose legacy footer block the composition will dedupe, and
 *     the footerless ones it will simply append to;
 *   * every body that would be **longer than 4,000 characters** once composed. That is
 *     the only thing it refuses on, because it is the only thing the release cannot do:
 *     `outbound_messages_body_bounded` would refuse the row, and a send that cannot be
 *     composed is a held step rather than an email. `refuses` is true, the ids are named,
 *     and `infra/scripts/preflight.sh` exits 3 before the release stops anything.
 *
 * Composition is measured with **no address**, because that is what the release meets:
 * schema 19's CHECK makes a `postal_address` row impossible, so on the day of the release
 * the footer is the sign-off and the stop line, exactly today's bytes. The worst case an
 * address would add is reported beside it, not as a refusal: `withMaxAddress` is what a
 * 200-character address (`POSTAL_ADDRESS_MAX_LENGTH`, plus its newline) would push past
 * the limit, so the owner knows which template to shorten before configuring one.
 *
 * Read-only: a READ ONLY transaction, rolled back. On any schema but 19 it refuses —
 * before 19 the release is not this one, after it 0020 has run.
 */

export const SCHEMA_PREFLIGHT_0020_MIGRATION = 20;

/** Ids are uuids, and a report is a log line: no body, no address, no prospect text. */
export interface Preflight0020Blocking {
  /** Unsent fences whose composed body would pass `SENT_BODY_MAX_LENGTH`. */
  readonly oversizeFences: number;
  /** Template versions whose composed body would pass it before a single variable grows. */
  readonly oversizeTemplates: number;
}

export interface Preflight0020Counts {
  readonly blocking: Preflight0020Blocking;
  /** One entry per key stored, with every version and the current one. */
  readonly settings: readonly { readonly settingKey: string; readonly versions: number; readonly current: number }[];
  /** The unsent fences the claim lock will reconcile. */
  readonly fences: {
    readonly prepared: number;
    readonly held: number;
    /** Already exactly what a send composes today: nothing is rewritten for these. */
    readonly alreadyComposed: number;
    /** Bodies that will be rewritten under the claim lock before dispatch. */
    readonly recomposed: number;
    /** Fences with no readable template version, kept only if their bytes already stand. */
    readonly withoutTemplateVersion: number;
  };
  /** What the composition will do to the stored template versions. */
  readonly templates: {
    readonly versions: number;
    readonly approved: number;
    /** The legacy shape: the block is inside the body and will be deduped at composition. */
    readonly legacyFooterBlock: number;
    /** No stop line at all: the footer is simply appended. */
    readonly footerless: number;
    /** A stop line the composition does not recognise as a block; these hold at send. */
    readonly stopLineElsewhere: number;
  };
  /** Necessarily false on schema 19: the CHECK this migration widens forbids the row. */
  readonly postalAddress: { readonly configured: boolean };
  /** Named, so the owner can shorten exactly these. */
  readonly oversize: {
    readonly fenceIds: readonly string[];
    readonly templateVersionIds: readonly string[];
    /** Not blocking: what a 200-character address would push past the limit. */
    readonly withMaxAddress: {
      readonly fenceIds: readonly string[];
      readonly templateVersionIds: readonly string[];
    };
  };
}

export type Preflight0020 =
  | {
      readonly applicable: true;
      readonly schemaVersion: number;
      readonly migration: number;
      readonly counts: Preflight0020Counts;
      /** True when a body would not fit once composed. Nothing else refuses. */
      readonly refuses: boolean;
    }
  | { readonly applicable: false; readonly schemaVersion: number; readonly migration: number };

interface SettingsRow {
  readonly setting_key: string;
  readonly versions: number;
  readonly current: number;
  readonly [column: string]: unknown;
}

interface BodyRow {
  readonly id: string;
  readonly state?: string;
  readonly body: string;
  readonly footer_sign_off: string | null;
  readonly approved_at?: Date | null;
  readonly [column: string]: unknown;
}

export const SCHEMA_PREFLIGHT_0020_SETTINGS_SQL = `
SELECT setting_key,
       count(*)::integer AS versions,
       count(*) FILTER (WHERE superseded_at IS NULL)::integer AS current
  FROM workspace_settings
 GROUP BY setting_key
 ORDER BY setting_key`;

/** Every fence nothing has been attempted with, and the sign-off its template names. */
export const SCHEMA_PREFLIGHT_0020_FENCES_SQL = `
SELECT o.id, o.state, o.body, t.footer_sign_off
  FROM outbound_messages o
  LEFT JOIN template_versions t
    ON t.workspace_id = o.workspace_id AND t.id = o.template_version_id
 WHERE o.state IN ('prepared', 'held')`;

export const SCHEMA_PREFLIGHT_0020_TEMPLATES_SQL = `
SELECT id, body, footer_sign_off, approved_at
  FROM template_versions
 WHERE retired_at IS NULL`;

/** The longest footer an address could add: the address and the newline before it. */
const MAX_ADDRESS_FOOTER_GROWTH = POSTAL_ADDRESS_MAX_LENGTH + 1;

export async function readSchemaPreflight0020(session: SessionQueryable): Promise<Preflight0020> {
  const schemaVersion = await readAppliedSchemaVersion(session);
  if (schemaVersion !== SCHEMA_PREFLIGHT_0020_MIGRATION - 1) {
    return { applicable: false, schemaVersion, migration: SCHEMA_PREFLIGHT_0020_MIGRATION };
  }
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const settings = await session.query<SettingsRow>(SCHEMA_PREFLIGHT_0020_SETTINGS_SQL);
    const fences = await session.query<BodyRow>(SCHEMA_PREFLIGHT_0020_FENCES_SQL);
    const templates = await session.query<BodyRow>(SCHEMA_PREFLIGHT_0020_TEMPLATES_SQL);

    const oversizeFenceIds: string[] = [];
    const oversizeTemplateIds: string[] = [];
    const nearlyOversizeFenceIds: string[] = [];
    const nearlyOversizeTemplateIds: string[] = [];
    let prepared = 0;
    let held = 0;
    let alreadyComposed = 0;
    let recomposed = 0;
    let withoutTemplateVersion = 0;

    for (const row of fences.rows) {
      if (row.state === 'held') held += 1;
      else prepared += 1;
      if (row.footer_sign_off === null) {
        withoutTemplateVersion += 1;
        if (sendBodyIssue(row.body) !== null) oversizeFenceIds.push(row.id);
        continue;
      }
      const decision = composeSendBody(row.body, { signOff: row.footer_sign_off, postalAddress: null });
      if (!decision.composed) {
        oversizeFenceIds.push(row.id);
        continue;
      }
      if (decision.changed) recomposed += 1;
      else alreadyComposed += 1;
      if (decision.body.length + MAX_ADDRESS_FOOTER_GROWTH > SENT_BODY_MAX_LENGTH) {
        nearlyOversizeFenceIds.push(row.id);
      }
    }

    let approved = 0;
    let legacyFooterBlock = 0;
    let footerless = 0;
    let stopLineElsewhere = 0;
    for (const row of templates.rows) {
      if (row.approved_at !== null && row.approved_at !== undefined) approved += 1;
      const decision = composeSendBody(row.body, {
        signOff: row.footer_sign_off ?? '',
        postalAddress: null,
      });
      if (!decision.composed) {
        if (decision.reason === 'composed_body_too_long') oversizeTemplateIds.push(row.id);
        else stopLineElsewhere += 1;
        continue;
      }
      if (decision.deduped) legacyFooterBlock += 1;
      else footerless += 1;
      if (decision.body.length + MAX_ADDRESS_FOOTER_GROWTH > SENT_BODY_MAX_LENGTH) {
        nearlyOversizeTemplateIds.push(row.id);
      }
    }

    const blocking: Preflight0020Blocking = {
      oversizeFences: oversizeFenceIds.length,
      oversizeTemplates: oversizeTemplateIds.length,
    };
    return {
      applicable: true,
      schemaVersion,
      migration: SCHEMA_PREFLIGHT_0020_MIGRATION,
      refuses: Object.values(blocking).some(value => value > 0),
      counts: {
        blocking,
        settings: settings.rows.map(row => ({
          settingKey: row.setting_key,
          versions: Number(row.versions),
          current: Number(row.current),
        })),
        fences: { prepared, held, alreadyComposed, recomposed, withoutTemplateVersion },
        templates: {
          versions: templates.rows.length,
          approved,
          legacyFooterBlock,
          footerless,
          stopLineElsewhere,
        },
        // The CHECK 0020 widens is the proof: no `postal_address` row can exist yet.
        postalAddress: { configured: false },
        oversize: {
          fenceIds: oversizeFenceIds,
          templateVersionIds: oversizeTemplateIds,
          withMaxAddress: {
            fenceIds: nearlyOversizeFenceIds,
            templateVersionIds: nearlyOversizeTemplateIds,
          },
        },
      },
    };
  } finally {
    await session.query('ROLLBACK');
  }
}

/**
 * The admin command. Read-only, as the runtime identity on the operations task, against
 * the database both services are still using. It exits 0 whatever the counts say, so the
 * whole answer reaches the log; `infra/scripts/preflight.sh` reads `refuses` and exits 3.
 */
export async function schemaPreflight0020Command(invocation: AdminInvocation): Promise<AdminOutcome> {
  const preflight = await readSchemaPreflight0020(invocation.session);
  if (!preflight.applicable) {
    return {
      ok: false,
      reason: 'schema_not_19',
      detail: `the database is at schema ${String(preflight.schemaVersion)}; migration 0020's preflight counts a schema-19 database`,
    };
  }
  return { ok: true, value: { ...preflight } };
}
