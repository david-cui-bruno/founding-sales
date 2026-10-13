import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '../../../db/queryable.ts';
import type { CallToBookingFixture } from './callToBookingCases.ts';
type Fixture = CallToBookingFixture;
const absent = '00000000-0000-4000-8000-000000006200';
function row(f: Fixture, patch: Record<string, SqlParameter> = {}) {
  return { workspace_id: f.seeded.alpha.workspaceId, id: randomUUID(), requested_by: f.seeded.alpha.salesperson.userId,
    source_refs: JSON.stringify([{ sourceId: randomUUID(), sourceRevision: 1, contentHash: 'a'.repeat(64) }]),
    source_fingerprint: 'a'.repeat(64), state: 'unavailable', reason: 'booking_authority_unavailable', ...patch };
}
async function insert(f: Fixture, fields: Record<string, SqlParameter>) {
  const columns = Object.keys(fields);
  return f.session.query(`INSERT INTO crm_booking_interpretations(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(fields));
}
export const BOOKING_INTERPRETATION_CONSTRAINT_CASES = [
  ...Object.entries({ source_refs: '{}', source_fingerprint: 'bad', provenance: '[]', state: 'permission', outcome: '[]',
    workspace_id: absent, requested_by: absent, reservation_id: absent }).map(([column, value]) => ({
    constraint: ({ source_refs: 'crm_booking_interpretations_sources', source_fingerprint: 'crm_booking_interpretations_fingerprint',
      provenance: 'crm_booking_interpretations_provenance', state: 'crm_booking_interpretations_state', outcome: 'crm_booking_interpretations_outcome',
      workspace_id: 'crm_booking_interpretations_workspace_id_fkey', requested_by: 'crm_booking_interpretations_workspace_id_requested_by_fkey',
      reservation_id: 'crm_booking_interpretations_workspace_id_reservation_id_fkey' } as Record<string, string>)[column]!,
    run: (f: Fixture) => insert(f, row(f, { [column]: value })),
  })),
  { constraint: 'crm_booking_interpretations_pkey', run: async (f: Fixture) => { const fields = row(f); await insert(f, fields); return insert(f, fields); } },
] as const;
