import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../../db/queryable.ts';
type Fixture = { session: SessionQueryable };
type Case = { constraint: string; run: (fixture: Fixture) => Promise<unknown> };
const automatic = () => ({ source_kind: 'automatic_research', publication_id: randomUUID(), publication_revision: 1, candidate_revision: 1, evidence_fingerprint: 'a'.repeat(64) });
const invalid = [
  () => ({ ...automatic(), source_kind: 'raw_discovery' }),
  () => ({ ...automatic(), publication_id: null }),
  () => ({ ...automatic(), publication_revision: null }),
  () => ({ ...automatic(), publication_revision: 0 }),
  () => ({ ...automatic(), candidate_revision: null }),
  () => ({ ...automatic(), candidate_revision: 0 }),
  () => ({ ...automatic(), evidence_fingerprint: null }),
  () => ({ ...automatic(), evidence_fingerprint: 'invalid' }),
  () => ({ ...automatic(), source_kind: 'discovery_research' }),
];
/** New names only. Privileged rolled-back catalog fixture isolates the new CHECK
 * before documentary FKs. Actual current lineage/immutable triggers are exercised
 * against real registered-source admissions in campaignComposition.spec.ts. */
export const campaignCompositionCases: readonly Case[] = invalid.map(change => ({
  constraint: 'email_campaign_admission_source',
  run: async ({ session }) => {
    await session.query('DROP TRIGGER email_campaign_admission_lineage ON outreach_email_campaign_admissions');
    await session.query('DROP TRIGGER email_campaign_automatic_lineage ON outreach_email_campaign_admissions');
    const row = { workspace_id: randomUUID(), campaign_id: randomUUID(), firm_id: randomUUID(), contact_id: randomUUID(), route_id: randomUUID(), plan_id: randomUUID(), enrollment_id: randomUUID(), candidate_id: randomUUID(), qualification_run_id: randomUUID(), ...change() };
    return session.query(`INSERT INTO outreach_email_campaign_admissions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(row));
  },
}));
