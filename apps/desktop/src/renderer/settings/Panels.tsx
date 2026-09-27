import type { JSX } from 'react';
import type { AdminView } from '../settingsView.ts';
import { Button } from '../ui/button.tsx';
import { Row, RowActions, RowMain, Rows, Section } from '../ui/layout.tsx';

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
}: {
  readonly view: AdminView;
  onAcknowledge?(alertId: string): void;
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
        </Section>
      )}
    </>
  );
}
