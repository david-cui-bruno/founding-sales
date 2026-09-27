import { useEffect, type JSX } from 'react';
import type { DesktopState, MailboxState } from '../../shared/contract.ts';
import { shortDay, shortDayTime } from '../dates.ts';
import { UNAVAILABLE } from '../homeView.ts';
import { MAILBOX_ROW_LABEL, buildMailboxView } from '../viewModel.ts';
import { Button } from '../ui/button.tsx';

/**
 * "This Mac": the device, the Mailbox row with its one control, the workspace's other
 * Macs, and Sign out.
 *
 * The Mailbox row is `buildMailboxView`'s answer and nothing else — what the server last
 * said, the one control it offers, and a refusal as plain text where the button is,
 * never in a dialog that blocks the window. There is no Disconnect; `MailboxBridge` in
 * the shared contract says why.
 *
 * The other Macs are read when this panel is opened and not before (wave 3b, S7): a
 * list of somebody's machines is not something Home needs to draw, and `GET /devices` is
 * a call nobody made until they asked. "Sign that Mac out" revokes one of them; the
 * server decides what that means, including when the id is this Mac's own.
 */
export function ThisMac({
  desktop,
  mailbox,
  mailboxWaiting,
  hasMailboxBridge,
  opened,
  onConnect,
  onSignOut,
  onListDevices,
  onRevokeDevice,
}: {
  readonly desktop: DesktopState;
  readonly mailbox: MailboxState | null;
  readonly mailboxWaiting: boolean;
  readonly hasMailboxBridge: boolean;
  /** Whether the disclosure this panel lives in is open. */
  readonly opened: boolean;
  onConnect(): void;
  onSignOut(): void;
  onListDevices(): void;
  onRevokeDevice(deviceId: string): void;
}): JSX.Element {
  const device = desktop.device;
  const signedIn = device !== null;
  // Once, when the panel is opened by somebody who is signed in.
  useEffect(() => {
    if (!opened || !signedIn || desktop.devices !== null) return;
    onListDevices();
  }, [opened, signedIn, desktop.devices, onListDevices]);

  const others = (desktop.devices ?? []).filter(entry => !entry.thisDevice);
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

      {device === null || desktop.devices === null ? null : (
        <section data-testid="other-macs" className="flex flex-col gap-1">
          <p className="text-muted-foreground">
            {others.length === 0 ? 'No other Mac is signed in to this workspace.' : 'Other Macs in this workspace'}
          </p>
          {others.map(entry => (
            <div key={entry.deviceId} data-testid="other-mac" className="flex items-center gap-2">
              <span data-testid="other-mac-line" className="flex-1 truncate">
                {`${entry.deviceLabel} — ${entry.status === 'revoked' ? 'signed out' : 'signed in'}, last seen ${
                  entry.lastSeenAt === null ? `never (added ${shortDay(entry.registeredAt)})` : shortDayTime(entry.lastSeenAt)
                }`}
              </span>
              {entry.status === 'revoked' ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={`revoke-${entry.deviceId}`}
                  onClick={() => {
                    onRevokeDevice(entry.deviceId);
                  }}
                >
                  Sign that Mac out
                </Button>
              )}
            </div>
          ))}
        </section>
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
