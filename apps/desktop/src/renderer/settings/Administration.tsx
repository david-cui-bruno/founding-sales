import { useState, type JSX } from 'react';
import type { AdminView } from '../settingsView.ts';
import { inertSentence } from '../settingsView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Field, Row, RowActions, RowMain, Rows, Section } from '../ui/layout.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { CallingNumberSection } from './CallingNumberSection.tsx';
import { PosturesSection } from './PosturesSection.tsx';
import { SendingSection } from './SendingSection.tsx';
import { SettingRow } from './SettingRow.tsx';
import type { AdminActions } from './useAdmin.ts';

/**
 * Settings › Administration (specification 10.1, 13.3, 14.2).
 *
 * In the order a person needs them: the number Today calls from, the states it may call,
 * whether sending is on, the workspace settings, the stages, the holidays, and the
 * sending domain. Nothing here decides anything — whether sending is effectively on is
 * the API's answer, read out, because a second implementation of that AND on the client
 * would be a second place for 16.2 to be wrong.
 */

/**
 * G8's holiday calendar, edited here and written by G8's command.
 *
 * A calendar is superseded, never edited in place, because every due instant G8 stores
 * freezes the calendar version it was computed under. So the control asks for a *new
 * version name* alongside the dates, and the current version is shown beside it rather
 * than prefilled — prefilling would invite a name that is already taken and a refusal the
 * person did not expect. The dates are one per line, which is the shape a person pastes
 * from a payroll calendar.
 */
function Holidays({ view, actions }: { readonly view: AdminView; readonly actions: AdminActions }): JSX.Element | null {
  const holidays = view.holidays;
  const [version, setVersion] = useState('');
  const [dates, setDates] = useState<string | null>(null);
  if (holidays === null) return null;
  const text = dates ?? holidays.dates.join('\n');
  return (
    <Section data-testid="holidays" title="Workspace holidays" count={holidays.dates.length}>
      <p data-testid="holidays-current" className="py-1 text-sm">
        {holidays.line}
      </p>
      <div className="mt-2 flex flex-col gap-3">
        <Field label="A name for the new version" htmlFor="holiday-version">
          <Input
            id="holiday-version"
            data-testid="holiday-version"
            type="text"
            autoComplete="off"
            placeholder="2027-federal"
            disabled={!holidays.editable}
            value={version}
            onChange={event => {
              setVersion(event.target.value);
            }}
            className="w-56"
          />
        </Field>
        <Field label="Dates, one per line" htmlFor="holiday-dates">
          <Textarea
            id="holiday-dates"
            data-testid="holiday-dates"
            rows={6}
            disabled={!holidays.editable}
            value={text}
            onChange={event => {
              setDates(event.target.value);
            }}
          />
        </Field>
        <div>
          <Button
            size="sm"
            data-testid="holidays-save"
            disabled={!holidays.editable}
            onClick={() => {
              actions.recordHolidayCalendar({
                version,
                dates: text
                  .split('\n')
                  .map(line => line.trim())
                  .filter(line => line.length > 0),
              });
            }}
          >
            Replace calendar
          </Button>
        </div>
        {holidays.notEditableBecause === null ? null : (
          <p className="text-xs text-muted-foreground">{inertSentence(holidays.notEditableBecause)}</p>
        )}
      </div>
    </Section>
  );
}

export function Administration({
  view,
  actions,
}: {
  readonly view: AdminView;
  readonly actions: AdminActions;
}): JSX.Element {
  return (
    <>
      <CallingNumberSection
        section={view.callingNumber}
        onAdd={actions.addCallingNumber}
        onRetire={actions.retireCallingNumber}
      />
      {view.postures === null ? null : (
        <PosturesSection
          section={view.postures}
          onAllow={actions.allowStates}
          onRevoke={actions.revokePosture}
          onRetry={() => {
            actions.show('administration');
          }}
        />
      )}

      <Section data-testid="settings" title="Workspace settings">
        {view.sending === null ? null : (
          <p data-testid="sending" className="py-1 text-sm">
            {view.sending.line}
          </p>
        )}
        <div className="mt-1 border-t border-border">
          {view.settings.map(row => (
            <SettingRow
              key={row.settingKey}
              row={row}
              history={view.history}
              onSave={actions.saveSetting}
              onHistory={actions.openHistory}
            />
          ))}
        </div>
      </Section>

      <Section data-testid="stages" title="Pipeline stages" count={view.stages.length}>
        <Rows>
          {view.stages.map(stage => (
            <Row key={stage.key} data-testid={`stage-${stage.key}`}>
              <RowMain
                line={stage.label}
                detail={stage.administrable || stage.note === null ? null : inertSentence(stage.note)}
              />
              {stage.administrable ? (
                <RowActions>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`retire-${stage.key}`}
                    onClick={() => {
                      actions.retireStage(stage.key);
                    }}
                  >
                    Retire
                  </Button>
                </RowActions>
              ) : null}
            </Row>
          ))}
        </Rows>
      </Section>

      <Holidays view={view} actions={actions} />
      <SendingSection
        view={view}
        onRecord={actions.recordSendingAuthentication}
        onCap={actions.setSendingCap}
        onRetry={() => {
          actions.show('administration');
        }}
      />
    </>
  );
}
