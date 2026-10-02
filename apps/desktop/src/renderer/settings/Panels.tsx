import type { JSX } from 'react';
import type { AdminView } from '../settingsView.ts';
import { Button } from '../ui/button.tsx';
import { Row, RowActions, RowMain, Rows } from '../ui/layout.tsx';
import { FormNotice } from './FormNotice.tsx';
import { Section } from './Group.tsx';

/**
 * Settings › Dashboard and Settings › Diagnostics: the figures, kept small.
 *
 * Every panel is `settingsView.ts`'s. A figure that cannot be computed says so — an
 * unavailable panel shows its reason and no number, because zero is a measurement and
 * "nothing can tell you how many" is not.
 */
export function Panels({
  view,
  onAcknowledge,
  acknowledging,
}: {
  readonly view: AdminView;
  onAcknowledge?(alertId: string): void;
  /** Whether this row's own Acknowledge is on the wire (P1-4). */
  acknowledging?(alertId: string): boolean;
}): JSX.Element {
  return (
    <>
      <div data-testid="panels">
        {view.panels.map(panel => (
          <Section
            key={panel.title}
            data-testid={`panel-${panel.title.toLowerCase().replaceAll(' ', '-')}`}
            title={panel.title}
          >
            {panel.unavailable === null ? null : (
              <p className="py-1 text-sm text-muted-foreground">{panel.unavailable}</p>
            )}
            <div className="flex flex-col gap-0.5">
              {panel.lines.map(line => (
                <p key={line} className="text-sm">
                  {line}
                </p>
              ))}
            </div>
          </Section>
        ))}
      </div>

      {onAcknowledge === undefined ? null : (
        <Section data-testid="alerts" title="Alerts" count={view.alerts.length}>
          {view.alerts.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">Nothing is alerting.</p>
          ) : (
            <Rows>
              {view.alerts.map(alert => (
                <Row key={alert.alertId} data-testid={`alert-${alert.alertId}`}>
                  <RowMain
                    line={alert.label}
                    detail={alert.runbookPath === null ? null : <span className="runbook">{alert.runbookPath}</span>}
                  />
                  {alert.acknowledgeable ? (
                    <RowActions>
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`acknowledge-${alert.alertId}`}
                        disabled={acknowledging?.(alert.alertId) === true}
                        {...(acknowledging?.(alert.alertId) === true ? { 'aria-busy': true } : {})}
                        onClick={() => {
                          onAcknowledge(alert.alertId);
                        }}
                      >
                        Acknowledge
                      </Button>
                    </RowActions>
                  ) : null}
                </Row>
              ))}
            </Rows>
          )}
          <div className="mt-2 empty:hidden">
            <FormNotice forms={['alert']} />
          </div>
        </Section>
      )}
    </>
  );
}
