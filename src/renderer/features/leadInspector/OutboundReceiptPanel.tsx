import type { OutboundReceipt } from '../../../shared/contracts/outboundContract';
import { Button } from '../../components/Button';

export type OutboundReceiptPanelProps = {
  receipt: OutboundReceipt;
  onLogPastActivity(commandId: string): void;
};

export function outboundReceiptMessage(receipt: OutboundReceipt): string {
  const channel = receipt.channel === 'call' ? 'Phone handoff' : receipt.channel === 'text' ? 'Text request' : 'Email request';
  return receipt.status === 'handoff_accepted'
    ? 'Phone handoff accepted. Call outcome unverified.'
    : receipt.status === 'unknown' ? `${channel} unknown. Do not retry.`
      : receipt.status === 'refused' ? `${channel} refused.` : `${channel} unavailable.`;
}

export function OutboundReceiptPanel({ receipt, onLogPastActivity }: OutboundReceiptPanelProps) {
  const canLinkCall = receipt.channel === 'call' && (receipt.status === 'handoff_accepted' || receipt.status === 'unknown');
  return (
    <section className="outbound-receipt" aria-label="Outbound execution status">
      <p role="status">{outboundReceiptMessage(receipt)}</p>
      {receipt.reasonCode !== null && <p>{receipt.reasonCode}</p>}
      <p className="outbound-receipt__command">{receipt.commandId}</p>
      {canLinkCall && <Button variant="quiet" onClick={() => onLogPastActivity(receipt.commandId)}>Log past activity</Button>}
    </section>
  );
}
