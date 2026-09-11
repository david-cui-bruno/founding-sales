import type { DiscoveryClaim } from '../../shared/contracts/discoveryContract';

export type DiscoveryResearchPort = {
  capability(): 'not_configured' | 'available';
  research(input: { personId: string; claims: readonly DiscoveryClaim[];
    questions: readonly string[]; signal: AbortSignal }): Promise<readonly DiscoveryClaim[]>;
};

/** No credentials, provider, network or fabricated research in local delivery. */
export const unavailableDiscoveryResearch: DiscoveryResearchPort = Object.freeze({
  capability: () => 'not_configured' as const,
  research: async () => { throw new Error('Additional research not configured'); },
});
