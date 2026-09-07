import { expect, it } from 'vitest';
import { unavailableDiscoveryResearch } from '../../src/main/discovery/discoveryResearchPort';

it('makes production research explicitly unavailable instead of simulating evidence', async () => {
  expect(unavailableDiscoveryResearch.capability()).toBe('not_configured');
  await expect(unavailableDiscoveryResearch.research({ personId: 'synthetic', claims: [], questions: [],
    signal: new AbortController().signal })).rejects.toThrow('Additional research not configured');
});
