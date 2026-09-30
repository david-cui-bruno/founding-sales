import { useCallback, useState, type JSX } from 'react';
import type { MailboxState } from '../../shared/contract.ts';
import {
  DEFAULT_SWITCH_TARGET,
  SWITCH_MAILBOX_LABEL,
  buildMailboxSection,
  switchTargetIssue,
} from '../viewModel.ts';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Field, Row, RowMain, Rows, Section } from '../ui/layout.tsx';
import { Input } from '../ui/input.tsx';

/**
 * Settings › Mailbox: which mailbox Callie sends from, how far it has read, and the one
 * way to change it (call-to-booking A3).
 *
 * The section is `buildMailboxSection`'s answer and nothing else. "Switch mailbox…"
 * opens a confirmation that says what carries over and what happens next; Continue hands
 * the address to the main process, which opens Google's consent screen in the browser and
 * waits for *this* attempt's outcome. There is no Disconnect here either.
 */

const CARRIES_OVER = ['Conversation history', 'The suppression list', 'Follow-up permissions', 'Send history'] as const;

const WHAT_HAPPENS_NEXT = [
  'Google asks you to choose the account.',
  'Callie reads the last 30 days of the new mailbox before it can send.',
  'Automated sending stays paused until you resume it.',
] as const;

export function MailboxSection({
  mailbox,
  waiting,
  available,
  onSwitch,
}: {
  readonly mailbox: MailboxState | null;
  readonly waiting: boolean;
  /** False in a page built without the preload: the section says so instead of offering a button. */
  readonly available: boolean;
  onSwitch(switchTo: string): void;
}): JSX.Element {
  const view = buildMailboxSection(mailbox, { waiting });
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(DEFAULT_SWITCH_TARGET);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  const issue = switchTargetIssue(target, view.address);

  return (
    <Section data-testid="mailbox-section" title="Mailbox">
      {!available ? (
        <p className="py-2 text-sm text-muted-foreground">Mailbox unavailable here.</p>
      ) : (
        <Rows>
          <Row>
            <RowMain
              line={<span data-testid="mailbox-address">{view.address ?? 'No mailbox connected'}</span>}
              detail={
                <>
                  <span data-testid="mailbox-state">{view.stateLine}</span>
                  {view.syncedLine === null ? null : (
                    <>
                      {' · '}
                      <span data-testid="mailbox-synced">{view.syncedLine}</span>
                    </>
                  )}
                </>
              }
            />
            {view.waitingLine !== null ? (
              <span data-testid="mailbox-waiting" className="text-xs text-muted-foreground">
                {view.waitingLine}
              </span>
            ) : view.canSwitch ? (
              <Button
                variant="outline"
                size="sm"
                data-testid="mailbox-switch"
                onClick={() => {
                  setTarget(DEFAULT_SWITCH_TARGET);
                  setOpen(true);
                }}
              >
                {SWITCH_MAILBOX_LABEL}
              </Button>
            ) : null}
          </Row>
          {view.baselineLine === null ? null : (
            <Row>
              <RowMain line={<span data-testid="mailbox-baseline" className="text-muted-foreground">{view.baselineLine}</span>} />
            </Row>
          )}
          {view.notice === null ? null : (
            <Row>
              <RowMain line={<span data-testid="mailbox-switch-notice">{view.notice}</span>} />
            </Row>
          )}
          {view.lastRefusal === null ? null : (
            <Row>
              <RowMain
                line={<span data-testid="mailbox-last-refusal" className="text-muted-foreground">{`Last attempt: ${view.lastRefusal}`}</span>}
              />
            </Row>
          )}
        </Rows>
      )}

      <Dialog
        open={open}
        title="Switch the sales mailbox"
        onClose={close}
        data-testid="switch-dialog"
        footer={
          <>
            <Button variant="quiet" size="sm" data-testid="switch-cancel" onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="switch-continue"
              disabled={issue !== null}
              onClick={() => {
                if (issue !== null) return;
                setOpen(false);
                onSwitch(target.trim());
              }}
            >
              Continue
            </Button>
          </>
        }
      >
        <p data-testid="switch-route" className="pb-3">
          From <strong className="font-medium">{view.address ?? 'no mailbox'}</strong> to{' '}
          <strong className="font-medium">{target.trim() === '' ? '…' : target.trim()}</strong>
        </p>
        <Field
          label="New mailbox address"
          htmlFor="switch-target"
          issues={issue === null ? [] : [{ testId: 'switch-target-issue', text: issue }]}
        >
          <Input
            id="switch-target"
            data-testid="switch-target"
            type="email"
            autoComplete="off"
            value={target}
            aria-invalid={issue !== null}
            onChange={event => {
              setTarget(event.target.value);
            }}
          />
        </Field>
        <h3 className="mt-4 mb-1 text-xs font-medium text-muted-foreground">What carries over</h3>
        <ul data-testid="switch-carries" className="flex flex-col divide-y divide-border border-t border-b border-border">
          {CARRIES_OVER.map(item => (
            <li key={item} className="py-1">
              {item}
            </li>
          ))}
        </ul>
        <h3 className="mt-4 mb-1 text-xs font-medium text-muted-foreground">What happens next</h3>
        <ul data-testid="switch-next" className="flex flex-col divide-y divide-border border-t border-b border-border">
          {WHAT_HAPPENS_NEXT.map(item => (
            <li key={item} className="py-1">
              {item}
            </li>
          ))}
        </ul>
      </Dialog>
    </Section>
  );
}
