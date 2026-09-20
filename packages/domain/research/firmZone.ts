import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { resolveFirmZone } from '../src/rules/statePosture.ts';
import { RESEARCH_FIRM_ZONE_SOURCES } from './zone.ts';
import { accept, numeric, refuse, type ResearchResult } from './types.ts';

/**
 * Recording a firm's coordinate, and resolving its zone from it
 * (specification 9.2, and the coordinator's note of 20 September).
 *
 * Two writes, kept apart for one reason: a coordinate is evidence about where the firm
 * is, and the four zone columns are a *decision* made from it under a named rule
 * version. Keeping them in separate statements means a later rule version can
 * re-decide every firm from coordinates that were never re-fetched, which is the whole
 * point of recording the rule version at all.
 *
 * `resolveZoneForFirm` in `@fss/domain/crm` stays as it is, resolving from the postal
 * table only. That is correct rather than an omission: a firm typed in by hand has an
 * address and no coordinate, so a coordinate source there would only ever return
 * null. Research is the path that has coordinates, so research carries them, and the
 * postal table remains the fallback behind them for both paths.
 */

export interface FirmCoordinateInput {
  readonly firmId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly providerKey: string;
  /** The provider's own reference for the listing the coordinate came from. */
  readonly sourceReference: string;
  readonly retrievedAt?: Date | undefined;
}

/**
 * Record or replace the firm's coordinate.
 *
 * One row per firm: the newest retrieval wins, and `retrieved_at` says when. The
 * history is in `evidence_items` — the listing that carried the coordinate is recorded
 * there with its content hash — so replacing the row loses nothing.
 */
export async function recordFirmCoordinate(
  context: RepositoryContext,
  input: FirmCoordinateInput,
): Promise<ResearchResult<{ readonly firmId: string }>> {
  if (
    !Number.isFinite(input.latitude) ||
    !Number.isFinite(input.longitude) ||
    input.latitude < -90 ||
    input.latitude > 90 ||
    input.longitude < -180 ||
    input.longitude > 180
  ) {
    return refuse('invalid_input');
  }

  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason === 'firm_merged' ? 'firm_merged' : 'not_assigned');

  await context.db.query(
    `INSERT INTO firm_locations
       (workspace_id, firm_id, latitude, longitude, provider_key, source_reference, retrieved_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT ON CONSTRAINT firm_locations_pkey DO UPDATE
        SET latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            provider_key = EXCLUDED.provider_key,
            source_reference = EXCLUDED.source_reference,
            retrieved_at = EXCLUDED.retrieved_at,
            updated_at = now()`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.latitude,
      input.longitude,
      input.providerKey,
      input.sourceReference,
      input.retrievedAt ?? null,
    ],
  );
  return accept({ firmId: input.firmId });
}

export interface FirmCoordinate {
  readonly latitude: number;
  readonly longitude: number;
  readonly providerKey: string;
  readonly sourceReference: string;
}

export async function readFirmCoordinate(
  context: RepositoryContext,
  firmId: string,
): Promise<FirmCoordinate | null> {
  const { rows } = await context.db.query<{
    latitude: string;
    longitude: string;
    provider_key: string;
    source_reference: string;
  }>(
    `SELECT latitude, longitude, provider_key, source_reference
       FROM firm_locations WHERE workspace_id = $1 AND firm_id = $2`,
    [context.scope.workspaceId, firmId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const latitude = numeric(row.latitude);
  const longitude = numeric(row.longitude);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude, providerKey: row.provider_key, sourceReference: row.source_reference };
}

export interface ResearchZoneOutcome {
  readonly firmId: string;
  readonly timeZone: string | null;
  readonly confidence: 'high' | 'medium' | null;
  readonly source: string | null;
  readonly ruleVersion: string;
  readonly unresolvedReason: string | null;
}

/**
 * Resolve the firm's zone through the research source order — its own coordinate
 * first, then the postal table — and write whichever of the two shapes migration
 * 0004's CHECKs admit.
 *
 * Both outcomes are recorded. Section 9.2: "inability to establish it blocks calling",
 * and an unresolved reason on the row is what makes that a recorded fact that
 * `authorizeDial` refuses on, rather than the absence of one.
 *
 * Unlike G3a's command this does not refuse when the zone cannot be established. A
 * discovery run that created twenty firms, three of them near a time-zone seam, has
 * not failed; it has three firms a person has to place. The outcome says which.
 */
export async function resolveResearchFirmZone(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly recordedZone?: string | undefined },
): Promise<ResearchResult<ResearchZoneOutcome>> {
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason === 'firm_merged' ? 'firm_merged' : 'not_assigned');

  const coordinate = await readFirmCoordinate(context, input.firmId);
  const resolution = resolveFirmZone(
    {
      recordedZone: input.recordedZone,
      state: firm.region_code ?? undefined,
      postalCode: firm.postal_code ?? undefined,
      ...(coordinate === null ? {} : { latitude: coordinate.latitude, longitude: coordinate.longitude }),
    },
    RESEARCH_FIRM_ZONE_SOURCES,
  );

  if (resolution.kind === 'resolved') {
    await context.db.query(
      `UPDATE firms
          SET time_zone = $3, time_zone_confidence = $4, time_zone_source = $5,
              time_zone_rule_version = $6, time_zone_unresolved_reason = NULL, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [
        context.scope.workspaceId,
        input.firmId,
        resolution.zone,
        resolution.confidence,
        resolution.source,
        resolution.ruleVersion,
      ],
    );
    return accept({
      firmId: input.firmId,
      timeZone: resolution.zone,
      confidence: resolution.confidence,
      source: resolution.source,
      ruleVersion: resolution.ruleVersion,
      unresolvedReason: null,
    });
  }

  await context.db.query(
    `UPDATE firms
        SET time_zone = NULL, time_zone_confidence = NULL, time_zone_source = NULL,
            time_zone_rule_version = $3, time_zone_unresolved_reason = $4, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.firmId, resolution.ruleVersion, resolution.reason],
  );
  return accept({
    firmId: input.firmId,
    timeZone: null,
    confidence: null,
    source: null,
    ruleVersion: resolution.ruleVersion,
    unresolvedReason: resolution.reason,
  });
}
