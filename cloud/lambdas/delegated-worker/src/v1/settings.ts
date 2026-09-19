import { TERRITORY_CLEARANCE_STATEMENTS, TERRITORY_RULES_REVISION, TERRITORY_STATE_RULES } from '../../../../../src/shared/contracts/territoryClearanceContract';
import { settingsViewSchema, type SettingsView } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';
import { postureSummary, readPostures } from './postures';

/**
 * GET /v1/settings, first slice (S1b): the postures by state and the clearance reference texts, so David can record a
 * posture before S5 ships the rest of Settings. The reference texts are the shared clearance contract's statements and
 * per-state rules at `TERRITORY_RULES_REVISION` (revision 2, checked against the sources on 18 Sep 2026), copied out of
 * the frozen contract objects; the client records that revision on every posture it sends. Reading is never a decision.
 */
export function referenceTexts(): SettingsView['referenceTexts'] {
  return {
    revision: TERRITORY_RULES_REVISION,
    statements: { ...TERRITORY_CLEARANCE_STATEMENTS },
    states: Object.values(TERRITORY_STATE_RULES).map(rule => ({ state: rule.state, name: rule.name, summary: rule.summary,
      citation: { ...rule.citation }, furtherCitations: rule.furtherCitations.map(citation => ({ ...citation })) })),
  };
}

export async function readSettingsView(store: DynamoStore): Promise<SettingsView> {
  const now = store.now();
  const postures = await readPostures(store);
  return settingsViewSchema.parse({ postures: postures.map(record => postureSummary(record, now)), referenceTexts: referenceTexts() });
}
