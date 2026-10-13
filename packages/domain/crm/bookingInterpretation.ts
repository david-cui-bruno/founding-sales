import type { BookingInterpretationRequest, BookingInterpretationSource } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { loadBookingInterpretationSources } from './bookingInterpretationSources.ts';

export interface BookingInterpretationRow extends Record<string, unknown> {
  id: string; requested_by: string; source_refs: BookingInterpretationSource[]; source_fingerprint: string;
  provenance: unknown; authority_snapshot: unknown; state: string; reason: string | null; outcome: unknown; reservation_id: string | null;
}
export const BOOKING_INTERPRETATION_LIMITATIONS = ['candidate_not_permission', 'no_sending_or_booking', 'linkedin_intake_unavailable', 'actual_model_quality_unverified'] as const;
function view(row: BookingInterpretationRow) {
  return { requestId: row.id, state: row.state, reason: row.reason, outcome: row.outcome,
    provenance: row.provenance, limitations: BOOKING_INTERPRETATION_LIMITATIONS };
}
export async function requestBookingInterpretation(context: RepositoryContext, input: BookingInterpretationRequest) {
  if (context.scope.actor.kind !== 'user') return { ok: false as const, reason: 'booking_access_denied' };
  const sources = [input.source, ...input.priorSources];
  const loaded = await loadBookingInterpretationSources(context, sources);
  if (!loaded || loaded.originals[0]!.ownerUserId !== context.scope.actor.userId) return { ok: false as const, reason: 'booking_source_unavailable' };
  const row = (await context.db.query<BookingInterpretationRow>(
    `INSERT INTO crm_booking_interpretations(workspace_id,requested_by,source_refs,source_fingerprint,provenance,state,reason)
     VALUES($1,$2,$3::jsonb,$4,$5::jsonb,'unavailable','booking_authority_unavailable') RETURNING *`,
    [context.scope.workspaceId, context.scope.actor.userId, JSON.stringify(sources), loaded.fingerprint, JSON.stringify(loaded.provenance)])).rows[0]!;
  return { ok: true as const, value: view(row) };
}
export async function readBookingInterpretation(context: RepositoryContext, input: { requestId: string }) {
  if (context.scope.actor.kind !== 'user') return null;
  const row = (await context.db.query<BookingInterpretationRow>('SELECT * FROM crm_booking_interpretations WHERE workspace_id=$1 AND id=$2 AND requested_by=$3',
    [context.scope.workspaceId, input.requestId, context.scope.actor.userId])).rows[0];
  if (!row) return null;
  const loaded = await loadBookingInterpretationSources(context, row.source_refs);
  if (!loaded || loaded.fingerprint !== row.source_fingerprint) return { requestId: row.id, state: 'stale', reason: 'source_or_access_changed', outcome: null, provenance: null, limitations: BOOKING_INTERPRETATION_LIMITATIONS };
  return view(row);
}
