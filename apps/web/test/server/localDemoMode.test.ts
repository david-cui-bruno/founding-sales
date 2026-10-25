import { expect, it } from 'vitest';
import { localDemoManualPreparation } from '../../scripts/localdemoMode.ts';
import { checkReviewStart, reviewPlist, type ReviewReceipt } from '../../scripts/localdemoReviewWindowCore.ts';

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

it('propagates only explicit fictional selection through the independent supervisor allowlist', () => {
  const receipt: ReviewReceipt = { version: 1, label: 'fixture-label', target: 'fixture-target', directory: '/private/fixture', node: '/node', script: '/script', createdAt: '2026-10-25T00:00:00Z', minutes: 20, state: 'starting', controls: { status: 'status', stop: 'stop', log: 'log' } };
  const env = { FSS_SYNTHETIC_LOCAL_DEMO: '1', FSS_LOCAL_DEMO_MANUAL_PREPARATION: '1', UNRELATED_SECRET: 'not-copied' };
  const opted = reviewPlist(receipt, env);
  expect(opted).toContain('<key>FSS_LOCAL_DEMO_MANUAL_PREPARATION</key><string>1</string>');
  expect(opted).not.toContain('UNRELATED_SECRET');
  expect(opted).not.toContain('not-copied');
  expect(reviewPlist(receipt, {})).not.toContain('FSS_LOCAL_DEMO_MANUAL_PREPARATION');
  expect(() => checkReviewStart({ ...env, FSS_LOCAL_DEMO_MANUAL_PREPARATION: 'true' }, 'darwin')).toThrow('absent or exactly 1');
});
