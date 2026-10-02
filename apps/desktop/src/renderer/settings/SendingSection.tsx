import { useEffect, type JSX } from 'react';
import { SENDING_CHECK_LABELS, SENDING_CHECK_NAMES, type AdminView, type SendingAdminSectionView, type SendingCheckName } from '../settingsView.ts';
import type { RecordSendingAuthenticationInput, SetSendingCapInput } from '../settingsContract.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Row, RowActions, RowMain, Rows, Unread } from '../ui/layout.tsx';
import { useKeptMap } from '../replies/kept.ts';
import { FormNotice } from './FormNotice.tsx';
import { Section } from './Group.tsx';

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
 *
 * The form starts at what is saved, never blank (David, 29 September 2026): four boxes
 * ticked as `/outbound/status` has them and a cap field carrying the cap in force. It
 * re-seeds when the *saved values themselves* change — a save that went through, a
 * Refresh, another admin — and not merely when the page renders again, so a re-read
 * that answers the same thing does not take away what somebody is half-way through
 * typing.
 */

/** The saved checklist and caps as one string, so "changed" is a value question. */
function savedText(section: SendingAdminSectionView): string {
  return JSON.stringify([section.checks, section.ramps.map(ramp => [ramp.mailboxId, ramp.cap])]);
}

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
  const section = view.sendingAdmin;
  /*
   * What is typed here is kept above the route (S4R, criterion 7), one key per box and per
   * cap, each falling back to what is saved. A marker records which saved values the typing
   * was started from: when the saved values themselves change — a save that went through,
   * a Refresh, another admin — the typing is dropped and the form shows the new saved
   * values, as before. A re-read that answers the same thing leaves it alone.
   */
  const saved = section === null ? '' : savedText(section);
  const kept = useKeptMap('settings:sending:');
  const marker = kept.get('saved', saved);
  const clear = kept.clear;
  const setMarker = kept.set;
  useEffect(() => {
    if (section === null || marker === saved) return;
    clear();
    setMarker('saved', saved);
  }, [section, marker, saved, clear, setMarker]);
  const checks: Readonly<Record<string, boolean>> = Object.fromEntries(
    SENDING_CHECK_NAMES.map(name => [name, kept.get(`check:${name}`, section?.checks[name] === true ? 'yes' : 'no') === 'yes']),
  );
  const capText = (mailboxId: string, cap: number): string => kept.get(`cap:${mailboxId}`, String(cap));
  const setCheck = (name: string, on: boolean): void => {
    kept.set('saved', saved);
    kept.set(`check:${name}`, on ? 'yes' : 'no');
  };
  const setCap = (mailboxId: string, value: string): void => {
    kept.set('saved', saved);
    kept.set(`cap:${mailboxId}`, value);
  };

  if (view.sendingUnread !== null) {
    return (
      <Section data-testid="sending-admin" title="Sending domain and caps">
        <Unread line={view.sendingUnread.line} testId="sending-unread" retryTestId="sending-retry" onRetry={onRetry} />
      </Section>
    );
  }
  if (section === null) return null;
  const domain = section.domain;

  return (
    <Section data-testid="sending-admin" title="Sending domain and caps">
      <p data-testid="sending-domain" className="py-1 text-sm">
        {section.domainLine}
      </p>
      {section.finishingLine === null ? null : (
        <p data-testid="sending-finishing" className="py-1 text-sm text-muted-foreground">
          {section.finishingLine}
        </p>
      )}

      {domain === null ? null : (
        <>
          <div className="mt-2 flex flex-col gap-1">
            {SENDING_CHECK_NAMES.map((name: SendingCheckName) => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid={`sending-${name}`}
                  disabled={!section.editable}
                  checked={checks[name] === true}
                  onChange={event => {
                    setCheck(name, event.target.checked);
                  }}
                />
                {SENDING_CHECK_LABELS[name] ?? name}
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
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
            <FormNotice forms={['sending-domain']} />
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
                  value={capText(ramp.mailboxId, ramp.cap)}
                  onChange={event => {
                    setCap(ramp.mailboxId, event.target.value);
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
                      const amount = Number.parseInt(capText(ramp.mailboxId, ramp.cap), 10);
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
      <div className="mt-2 empty:hidden">
        <FormNotice forms={['sending-cap']} />
      </div>
    </Section>
  );
}
