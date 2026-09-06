// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboundReceipt } from '../../../shared/contracts/outboundContract';
import { OutboundReceiptPanel } from './OutboundReceiptPanel';
afterEach(cleanup);
const receipt: OutboundReceipt = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'call', status: 'handoff_accepted', reasonCode: null, mutation: { revision: 1, affectedPersonIds: ['p'], affectedSalesCycleIds: ['s'] } };
describe('OutboundReceiptPanel', () => {
  it.each([
    ['handoff_accepted', null, 'Phone handoff accepted. Call outcome unverified.'],
    ['unknown', 'handoff_uncertain', 'Phone handoff unknown. Do not retry.'],
    ['refused', 'federal_dnc_listed', 'Phone handoff refused.'],
    ['unavailable', 'phone_route_unverified', 'Phone handoff unavailable.'],
  ] as const)('shows truthful %s execution state without a delivery claim', (status, reasonCode, copy) => {
    const log = vi.fn();
    render(<OutboundReceiptPanel receipt={{ ...receipt, status, reasonCode }} onLogPastActivity={log} />);
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.getByText(receipt.commandId)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    if (status === 'handoff_accepted' || status === 'unknown') {
      fireEvent.click(screen.getByRole('button', { name: 'Log past activity' }));
      expect(log).toHaveBeenCalledWith(receipt.commandId);
    } else expect(screen.queryByRole('button')).toBeNull();
  });
  it('never associates a text attempt with the call form', () => {
    render(<OutboundReceiptPanel receipt={{ ...receipt, channel: 'text', status: 'unavailable', reasonCode: 'channel_unavailable' }} onLogPastActivity={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
