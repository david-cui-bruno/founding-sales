import type { JSX } from 'react';
import type { DesktopState, MailboxState } from '../../shared/contract.ts';
import { UNAVAILABLE } from '../homeView.ts';
import { MAILBOX_ROW_LABEL, buildMailboxView } from '../viewModel.ts';
import { Button } from '../ui/button.tsx';

/**
 * "This Mac": the device, the Mailbox row with its one control, and Sign out.
 *
 * The Mailbox row is `buildMailboxView`'s answer and nothing else — what the server last
 * said, the one control it offers, and a refusal as plain text where the button is,
 * never in a dialog that blocks the window. There is no Disconnect; `MailboxBridge` in
 * the shared contract says why.
 */
export function ThisMac({
  desktop,
  mailbox,
  mailboxWaiting,
  hasMailboxBridge,
  onConnect,
  onSignOut,
}: {
  readonly desktop: DesktopState;
  readonly mailbox: MailboxState | null;
  readonly mailboxWaiting: boolean;
  readonly hasMailboxBridge: boolean;
  onConnect(): void;
  onSignOut(): void;
}): JSX.Element {
  const device = desktop.device;
  const view = hasMailboxBridge
    ? buildMailboxView(mailbox, { waiting: mailboxWaiting })
    : { text: UNAVAILABLE, action: null, hint: null, notice: null };

  return (
    <section data-testid="device-panel" className="mt-2 flex flex-col gap-2">
      {device === null ? null : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
          {(
            [
              ['Name', device.deviceLabel],
              ['Device', device.deviceId],
              ['Workspace', device.workspaceId],
              ['Role', device.role],
              ['Registered', device.registeredAt],
            ] as const
          ).map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
          <dt className="text-muted-foreground">{MAILBOX_ROW_LABEL}</dt>
          <dd data-testid="mailbox-status" className="truncate">
            {view.text}
          </dd>
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {view.action === null ? null : (
          <Button variant="outline" size="sm" data-testid="mailbox-connect" disabled={!view.action.enabled} onClick={onConnect}>
            {view.action.label}
          </Button>
        )}
        <Button variant="outline" size="sm" data-testid="sign-out" onClick={onSignOut}>
          Sign out
        </Button>
      </div>

      {view.hint === null ? null : (
        <p data-testid="mailbox-hint" className="leading-relaxed">
          {view.hint}
        </p>
      )}
      {view.notice === null ? null : (
        <p data-testid="mailbox-notice" className="leading-relaxed">
          {view.notice}
        </p>
      )}
    </section>
  );
}
