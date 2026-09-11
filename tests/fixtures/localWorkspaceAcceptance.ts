import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../src/main/db/database';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { DISCOVERY_NOW, seedDiscoveryOwner } from './discoveryDatabase';

/** Synthetic records only. No workspace identity, worker, provider or transition. */
export function seedLocalWorkspaceAcceptance(database: AppDatabase) {
  const clock = { now: () => DISCOVERY_NOW }, ids = { next: randomUUID };
  const services = createDomainServices({ database, clock, ids });
  services.unitOfWork.immediate(() => {
    services.prioritizationRepository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
    services.cadences.installBuiltins();
  });
  const retained = seedDiscoveryOwner({ services, database }, { prefix: 'Retained callback', units: 12 });
  const automatic = seedDiscoveryOwner({ services, database }, { prefix: 'Old acquisition', units: 5 });
  // A real operational call follows review. Unreviewed contacts are deliberately
  // backlog-only in the existing Today scheduler, even when they have activity.
  services.lifecycle.reviewToReady({ cycleId: retained.salesCycleId, expectedCycleVersion: 1,
    expectedProspectVersion: 1, effectiveAt: DISCOVERY_NOW });
  const domain = new FounderSalesDomain({ services, database, clock, ids, timezone: 'America/New_York' });
  const callbackAt = '2026-09-06T13:00:00.000Z';
  domain.logCallOutcome({ personId: retained.personId, salesCycleId: retained.salesCycleId,
    outcome: 'spoke', occurredAt: DISCOVERY_NOW, callbackAt });
  const accounts = new AccountRepository({ database, clock, ids, sourcePolicy: { attest: () => true } });
  const account = accounts.create({ commandId: randomUUID(), name: 'Fixture Residential Management', domain: 'fixture.invalid' });
  const sourceId = randomUUID();
  accounts.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: account.version,
    sources: [{ id: sourceId, url: 'https://fixture.invalid/services', fetchedAt: DISCOVERY_NOW,
      sha256: 'a'.repeat(64), excerpt: 'Synthetic residential management evidence.', permitted: true }],
    claims: [{ key: 'residential_scope', kind: 'fact', value: 'residential', evidenceIds: [sourceId] }], routes: [] });
  const action = database.raw.prepare('SELECT current_next_action_id AS id FROM sales_cycles WHERE id=?')
    .get(retained.salesCycleId) as { id: string | null };
  if (!action.id) throw new Error('Synthetic retained action was not created');
  return { accountId: account.id, personId: retained.personId, salesCycleId: retained.salesCycleId,
    actionId: action.id, callbackAt, automaticCycleId: automatic.salesCycleId };
}
