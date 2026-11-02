import { DEFAULT_PEOPLE_ENRICHMENT, peopleEnrichmentSettingSchema, type PeopleEnrichmentSetting } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from './store.ts';

/** The workspace's people-enrichment switch and daily credit cap (migration 0160, ADR0036). A row that does not parse is the default: off. */
export async function readPeopleEnrichmentSetting(context: RepositoryContext): Promise<PeopleEnrichmentSetting> {
  const parsed = peopleEnrichmentSettingSchema.safeParse((await readSetting(context, 'people_enrichment')).value);
  return parsed.success ? parsed.data : DEFAULT_PEOPLE_ENRICHMENT;
}
