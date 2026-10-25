import { expect, it } from 'vitest';
import { localDemoManualPreparation } from '../../scripts/localdemoMode.ts';

it('preserves the original reply workflow unless manual preparation is explicitly selected', () => {
  expect(localDemoManualPreparation({})).toBe(false);
  expect(localDemoManualPreparation({ FSS_SYNTHETIC_LOCAL_DEMO: '1' })).toBe(false);
  expect(localDemoManualPreparation({ FSS_SYNTHETIC_LOCAL_DEMO: '1', FSS_LOCAL_DEMO_MANUAL_PREPARATION: '1' })).toBe(true);
});

it.each(['', '0', 'true', ' 1', '1 ', 'prospect'])('refuses ambiguous opt-in %j rather than silently changing fixtures', value => {
  expect(() => localDemoManualPreparation({ FSS_SYNTHETIC_LOCAL_DEMO: '1', FSS_LOCAL_DEMO_MANUAL_PREPARATION: value })).toThrow('absent or exactly 1');
});

it('does not authorize a non-synthetic workspace', () => {
  expect(() => localDemoManualPreparation({ FSS_LOCAL_DEMO_MANUAL_PREPARATION: '1' })).toThrow('explicit synthetic');
});
