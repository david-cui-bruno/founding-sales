import type { DiscoveryApi } from '../../shared/contracts/discoveryContract';
import type { FounderSalesDomain } from '../domain/founderSalesDomain';

/** Thin adapter. The application composition supplies per-invocation runtime leases. */
export function createDiscoveryProvider(
  domain: Pick<FounderSalesDomain, 'getDiscovery' | 'getDiscoveryBrief' | 'beginDiscovery' | 'overrideDiscovery'>,
): DiscoveryApi {
  return {
    get: async () => domain.getDiscovery(),
    getBrief: async input => domain.getDiscoveryBrief(input.personId),
    begin: async input => domain.beginDiscovery(input),
    override: async input => domain.overrideDiscovery(input),
  };
}
