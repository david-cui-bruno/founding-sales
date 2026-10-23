import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {TABLE_RETENTION_COVERAGE} from '../../retention/coverage.ts';

it('retains campaign approval and cap history, not private automatic publication custody',()=>{
 const campaign=readFileSync(new URL('../../db/migrations/0130_email_campaigns.sql',import.meta.url),'utf8');
 const composition=readFileSync(new URL('../../db/migrations/0132_automatic_campaign_sources.sql',import.meta.url),'utf8');
 const tables=[...campaign.matchAll(/CREATE TABLE (\w+)/gu)].map(match=>match[1]!);
 expect(tables).toEqual(['outreach_email_campaigns','outreach_email_campaign_admissions']);
 for(const table of tables)expect(TABLE_RETENTION_COVERAGE[table]?.dispositions,table).toEqual(['retained']);
 expect(TABLE_RETENTION_COVERAGE['sourcing_automatic_research_firms']?.dispositions).toEqual(['deletion_removes']);
 // The new source-kind lineage is documentary history, not an erasure dependency.
 expect(composition).toContain('ALTER TABLE outreach_email_campaign_admissions');
 expect(composition).not.toMatch(/REFERENCES sourcing_automatic_research_firms/iu);
 expect(composition).not.toMatch(/ON DELETE CASCADE/iu);
});
