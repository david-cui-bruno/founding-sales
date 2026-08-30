import { describe, expect, it, vi } from 'vitest';

import { SupervisedAppleBridgeService } from '../../src/main/appleBridge/appleBridgeService';

describe('SupervisedAppleBridgeService observation subscription', () => {
  it('fails explicitly instead of returning a no-op when ready has no current client', () => {
    const service = new SupervisedAppleBridgeService({
      getStatus: vi.fn(() => ({
        state: 'ready',
        helperVersion: '1.0.0',
        protocolVersion: 1,
      } as const)),
      getClient: vi.fn(() => undefined),
    });

    expect(() => service.subscribe(() => undefined)).toThrow(
      'Apple integration helper is unavailable.',
    );
  });
});
