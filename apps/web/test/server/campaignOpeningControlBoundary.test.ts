import { expect, it } from 'vitest';
import { campaignOpeningBrowserResult } from '../../src/server/campaignOpeningBoundary.ts';
const path = '/outreach/email-campaigns/opening/approve';
it.each(['approve', 'revoke'])('maps only finite %s refusal content without losing its code', action => {
  const body = { status: 'refused', replayed: false, reason: 'already_configured' };
  expect(campaignOpeningBrowserResult(`/outreach/email-campaigns/opening/${action}`, 409, body)).toEqual({ status: 200, body });
});
it.each([
  [path, 401, { status: 'refused', replayed: false, reason: 'campaign_unavailable' }],
  [path, 409, { status: 'refused', replayed: false, reason: 'command_id_reused' }],
  [path, 409, { error: 'opening_control_changed' }],
  [path, 409, { status: 'refused', replayed: false, reason: 'authority_changed' }],
  [path, 409, { status: 'refused', replayed: false, reason: 'expiry_invalid', privateCopy: 'forbidden' }],
  ['/outreach/email-campaigns/opening/receipt', 409, { status: 'refused', replayed: false, reason: 'expiry_invalid' }],
  ['/outreach/email-campaigns/approve', 409, { status: 'refused', replayed: false, reason: 'expiry_invalid' }],
  [path, 503, { status: 'refused', replayed: false, reason: 'expiry_invalid' }],
] as const)('preserves transport uncertainty %#', (route, status, body) => {
  expect(campaignOpeningBrowserResult(route, status, body)).toBeNull();
});
