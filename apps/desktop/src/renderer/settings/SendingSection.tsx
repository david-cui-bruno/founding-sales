import { useState, type JSX } from 'react';
import { SENDING_CHECK_LABELS, type AdminView } from '../settingsView.ts';
import type { RecordSendingAuthenticationInput, SetSendingCapInput } from '../settingsContract.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Row, RowActions, RowMain, Rows, Section, Unread } from '../ui/layout.tsx';

/**
 * G7-2's sending section (12.6, 12.7): the authentication checklist and the per-mailbox
 * cap.
 *
 * Absent rather than inert for anyone who is not an admin — every `/outbound/*` path
 * answers a salesperson with a redacted 403, and a control that exists only to be
 * refused teaches nothing.
 *
 * The four checkboxes are four separate facts because the command is: 12.7's checklist is
 * a person recording that they looked, and FSS never queries DNS. The enable is a fifth,
 * and `sending_domains` has a CHECK that refuses it without the other four — the page
 * does not pre-empt that refusal, it shows it. Nothing is clamped either: a raise above
 * 75 must come back as a refusal an admin reads, not a silent 75.
 */

const CHECKS = ['spfPass', 'dkimPass', 'dmarcPass', 'postmasterReviewed', 'automatedSendingEnabled'] as const;

export function SendingSection({
  view,
  recording,
  capping,
  onRecord,
  onCap,
  onRetry,
}: {
  readonly view: AdminView;
  /** Whether this section's own checklist save is on the wire (P1-4). */
  readonly recording: boolean;
  /** Whether a cap of this section's is on the wire. */
  readonly capping: boolean;
  onRecord(input: RecordSendingAuthenticationInput): void;
  onCap(input: SetSendingCapInput): void;
  onRetry(): void;
}): JSX.Element | null {
  const [checks, setChecks] = useState<Readonly<Record<string, boolean>>>({});
  const [caps, setCaps] = useState<Readonly<Record<string, string>>>({});

  if (view.sendingUnread !== null) {
    return (
      <Section data-testid="sending-admin" title="Sending domain and caps">
        <Unread line={view.sendingUnread.line} testId="sending-unread" retryTestId="sending-retry" onRetry={onRetry} />
      </Section>
    );
  }
  const section = view.sendingAdmin;
  if (section === null) return null;
  const domain = section.domain;

  return (
    <Section data-testid="sending-admin" title="Sending domain and caps">
      <p data-testid="sending-domain" className="py-1 text-sm">
        {section.domainLine}
      </p>

      {domain === null ? null : (
        <>
          <div className="mt-2 flex flex-col gap-1">
            {CHECKS.map(name => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid={`sending-${name}`}
                  disabled={!section.editable}
                  checked={checks[name] === true}
                  onChange={event => {
                    setChecks(current => ({ ...current, [name]: event.target.checked }));
                  }}
                />
                {SENDING_CHECK_LABELS[name] ?? name}
              </label>
            ))}
          </div>
          <div className="mt-3">
            <Button
              size="sm"
              data-testid="sending-record"
              disabled={!section.editable || recording}
              {...(recording ? { 'aria-busy': true } : {})}
              onClick={() => {
                onRecord({
                  domain,
                  spfPass: checks['spfPass'] === true,
                  dkimPass: checks['dkimPass'] === true,
                  dmarcPass: checks['dmarcPass'] === true,
                  postmasterReviewed: checks['postmasterReviewed'] === true,
                  automatedSendingEnabled: checks['automatedSendingEnabled'] === true,
                });
              }}
            >
              Record checklist
            </Button>
          </div>
        </>
      )}

      {section.ramps.length === 0 ? null : (
        <Rows data-testid="ramps" className="mt-4">
          {section.ramps.map(ramp => (
            <Row key={ramp.mailboxId} data-testid={`ramp-${ramp.mailboxId}`}>
              <RowMain line={ramp.line} />
              <RowActions>
                <Input
                  type="number"
                  aria-label="A daily cap"
                  data-testid={`cap-${ramp.mailboxId}`}
                  disabled={!ramp.editable}
                  value={caps[ramp.mailboxId] ?? ''}
                  onChange={event => {
                    setCaps(current => ({ ...current, [ramp.mailboxId]: event.target.value }));
                  }}
                  className="h-7 w-20 text-xs"
                />
                {(
                  [
                    ['Lower to', 'lowerTo'],
                    ['Raise to', 'raiseTo'],
                  ] as const
                ).map(([label, key]) => (
                  <Button
                    key={key}
                    size="sm"
                    variant="outline"
                    data-testid={`${key}-${ramp.mailboxId}`}
                    disabled={!ramp.editable || capping}
                    {...(capping ? { 'aria-busy': true } : {})}
                    onClick={() => {
                      const amount = Number.parseInt(caps[ramp.mailboxId] ?? '', 10);
                      if (!Number.isInteger(amount)) return;
                      onCap({ mailboxId: ramp.mailboxId, [key]: amount });
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </RowActions>
            </Row>
          ))}
        </Rows>
      )}
    </Section>
  );
}
