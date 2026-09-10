import type { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import type { createLeadsProvider } from '../../src/main/ipc/registerApplicationIpc';

/** Adapts an existing real facade only. This is not FoundationRuntime readiness evidence. */
export function productionDomainGate(domain: FounderSalesDomain): Parameters<typeof createLeadsProvider>[0] {
  return {
    withDomain: async operation => operation(domain),
    getHealth: async () => { throw new Error('Unexpected fixture health read'); },
  };
}
