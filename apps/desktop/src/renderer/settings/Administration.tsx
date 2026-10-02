import type { JSX } from 'react';
import type { AdminView } from '../settingsView.ts';
import { inertSentence } from '../settingsView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Field, Row, RowActions, RowMain, Rows } from '../ui/layout.tsx';
import { ChangedElsewhere, FormNotice } from './FormNotice.tsx';
import { Section } from './Group.tsx';
import { useKept, useKeptBased } from '../replies/kept.ts';
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
function Holidays({
  view,
  actions,
  saving,
}: {
  readonly view: AdminView;
  readonly actions: AdminActions;
  /** Whether this form's own Replace calendar is on the wire (P1-4). */
  readonly saving: boolean;
}): JSX.Element | null {
  const holidays = view.holidays;
  // Typed and not yet replaced: kept above the route, with the calendar as the fallback (S4R).
  const [version, setVersion] = useKept('settings:holidays:version', '');
  const datesKept = useKeptBased('settings:holidays:dates', holidays === null ? null : holidays.dates.join('\n'));
  const [text, setDates] = [datesKept.value, datesKept.set] as const;
  if (holidays === null) return null;
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
            disabled={!holidays.editable || saving}
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
            disabled={!holidays.editable || saving}
            value={text}
            onChange={event => {
              setDates(event.target.value);
            }}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            data-testid="holidays-save"
            disabled={!holidays.editable || saving}
            {...(saving ? { 'aria-busy': true } : {})}
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
          <FormNotice forms={['holidays']} />
          <ChangedElsewhere show={datesKept.elsewhere} />
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
  busy,
}: {
  readonly view: AdminView;
  readonly actions: AdminActions;
  /** Whether one named form's own command is on the wire; the sections do not share. */
  busy(form: string): boolean;
}): JSX.Element {
  return (
    <>
      <CallingNumberSection
        section={view.callingNumber}
        adding={busy('calling-number')}
        retiring={identityId => busy(`calling-number:${identityId}`)}
        onAdd={actions.addCallingNumber}
        onRetire={actions.retireCallingNumber}
      />
      {view.postures === null ? null : (
        <PosturesSection
          section={view.postures}
          adding={busy('postures')}
          revoking={postureId => busy(`posture:${postureId}`)}
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
              saving={busy(`setting:${row.settingKey}`)}
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
                    disabled={busy(`stage:${stage.key}`)}
                    {...(busy(`stage:${stage.key}`) ? { 'aria-busy': true } : {})}
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
        <div className="mt-2 empty:hidden">
          <FormNotice forms={['stage']} />
        </div>
      </Section>

      <Holidays view={view} actions={actions} saving={busy('holidays')} />
      <SendingSection
        view={view}
        recording={busy('sending-domain')}
        capping={busy('sending-cap')}
        onRecord={actions.recordSendingAuthentication}
        onCap={actions.setSendingCap}
        onRetry={() => {
          actions.show('administration');
        }}
      />
    </>
  );
}
