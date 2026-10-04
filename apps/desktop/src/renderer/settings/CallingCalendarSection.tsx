import { MeetingAutoRecordingSection } from './MeetingAutoRecordingSection.tsx';
import { MeetingFollowThroughSection } from './MeetingFollowThroughSection.tsx';
import { MeetingAnalysisSection } from './MeetingAnalysisSection.tsx';
import { MeetingTranscriptionSection } from './MeetingTranscriptionSection.tsx';
import type { JSX } from 'react';
import {
  MONTHLY_CASH_CEILING_MAX_CENTS,
  TRANSCRIPTION_DAILY_CEILING_MAX_CENTS,
  VOICEMAIL_PLACEHOLDERS,
  VOICEMAIL_TEMPLATE_MAX_CHARACTERS,
  reasonSentence,
  type IntegrationsSettingsResponse,
} from '@fss/contracts';
import type { AdminState, SaveIntegrationInput } from '../settingsContract.ts';
import { finishingSentence } from '../settingsView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Row, RowMain, Rows, Unread } from '../ui/layout.tsx';
import { useKeptBased } from '../replies/kept.ts';
import { ChangedElsewhere } from './FormNotice.tsx';
import { Section } from './Group.tsx';
import { Textarea } from '../ui/textarea.tsx';

/**
 * Settings › Calling & calendar (slice S1): the four switches David turns himself.
 *
 *   * **In-app calling** — `calling_provider` `twilio` or `tel`. It cannot be turned on
 *     while the server lacks the calling account's credentials, or while the daily budget
 *     is 0 (a call would be refused). It can always be turned off.
 *   * **Daily calling budget** — dollars a day, 0 to 100, kept as cents, with today's
 *     spend; the longest call in minutes is under "Advanced".
 *   * **Voicemail script** — the template the call card reads out, with its placeholders.
 *   * **Cal.com bookings** — `calendar_integration`; it cannot be turned on while the
 *     Cal.com webhook secret is missing.
 *
 *   * **Transcribe calls** and its **daily transcription budget** (slice C2) — present when
 *     the server answers them (`?include=transcription`). Off, and $0, until David sets
 *     them; it cannot be turned on while the transcription key is missing on the server.
 *   * **Monthly spending limit** (slice P1) — "This month: $x of $y", and the limit, $0 to
 *     $50 ($25 until David changes it). Present when the server answers it (`?include=month`).
 *     Below it, "Credits this month: $z" (slice C3a): Amazon Transcribe, paid from AWS
 *     credits, which the limit does not count (`?include=credits`).
 *
 * The section names no secret field, value or length: the read carries field *names* only
 * and this section says the account "is not set up" without listing them. Every refusal is
 * a sentence from `reasonSentence`, on the section, never a code.
 *
 * Absent for a salesperson (the read is not made); a failed read is one grey line and Retry.
 */

export const CALLING_NEEDS_SETUP = 'In-app calling needs the calling account to be set up on the server first.';
export const CALLING_NEEDS_BUDGET = 'Calling stays off until a daily budget is set.';
export const CALCOM_NEEDS_SECRET = 'Cal.com bookings need the Cal.com webhook secret to be set up on the server first.';
export const BUDGET_RANGE = 'Enter an amount from $0 to $100.';
/** A typed amount and a saved one are the same if they are the same number: "10" is "10.00". */
function sameNumber(typed: string, saved: string): boolean {
  return Number(typed) === Number(saved);
}

export const MINUTES_RANGE = 'Enter a whole number of minutes from 1 to 240.';
/**
 * No running worker can transcribe (slice C3a): with Amazon Transcribe that is the call-audio
 * bucket and the provider setting, with Deepgram its key — so the sentence names neither.
 */
export const TRANSCRIPTION_NEEDS_KEY = 'Call transcription needs the transcription service to be set up on the server first.';
export const TRANSCRIPTION_NEEDS_BUDGET = 'Transcription stays off until a daily transcription budget is set.';
export const TRANSCRIPTION_BUDGET_RANGE = 'Enter an amount from $0 to $5.';
export const MONTH_RANGE = 'Enter an amount from $0 to $50.';

/** Dollars typed → cents, or null when it is not an amount from 0 to 50. */
export function monthCentsFromDollars(typed: string): number | null {
  const cents = centsFromDollars(typed);
  return cents !== null && cents <= MONTHLY_CASH_CEILING_MAX_CENTS ? cents : null;
}

/** "This month: $3.40 of $25.00." — what the month has cost against its limit. */
export function monthLine(month: { readonly ceilingCents: number; readonly spentMonthCents: number }): string {
  return `This month: ${money(month.spentMonthCents)} of ${money(month.ceilingCents)}. Calls, transcription, research and reply reading stop when the limit is reached.`;
}

/**
 * "Credits this month: $0.12 …" (slice C3a) — what the month's credit-funded transcription
 * cost, which the limit does not count. Shown when the server answers it.
 */
export function creditsLine(creditsMonthCents: number): string {
  return `Credits this month: ${money(creditsMonthCents)}. Transcription paid from AWS credits is not counted against the limit.`;
}

/** Dollars typed → cents, or null when it is not an amount from 0 to 5. */
export function transcriptionCentsFromDollars(typed: string): number | null {
  const cents = centsFromDollars(typed);
  return cents !== null && cents <= TRANSCRIPTION_DAILY_CEILING_MAX_CENTS ? cents : null;
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** Dollars typed → cents, or null when it is not an amount from 0 to 100. */
export function centsFromDollars(typed: string): number | null {
  const text = typed.trim().replace(/^\$/u, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/u.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return cents >= 0 && cents <= 10_000 ? cents : null;
}

function minutesFrom(typed: string): number | null {
  if (!/^\d{1,3}$/u.test(typed.trim())) return null;
  const minutes = Number(typed.trim());
  return minutes >= 1 && minutes <= 240 ? minutes : null;
}

export function CallingCalendarSection({
  state,
  busy,
  onSave,
  onRetry,
}: {
  readonly state: AdminState;
  /** Whether the save of this setting key is on the wire. */
  busy(settingKey: SaveIntegrationInput['settingKey']): boolean;
  onSave(input: SaveIntegrationInput): void;
  onRetry(): void;
}): JSX.Element | null {
  if (state.role !== 'admin') return null;
  const integrations = state.integrations ?? null;
  if (integrations === null) {
    return (
      <Section data-testid="calling-calendar" title="Calling & calendar">
        <Unread
          line="Callie could not read the calling and calendar settings."
          testId="calling-calendar-unread"
          retryTestId="calling-calendar-retry"
          onRetry={onRetry}
        />
      </Section>
    );
  }
  return (
    <Loaded
      // A new server answer (after a save) resets the drafts to what is now in force.
      key={JSON.stringify([
        integrations.telephonyBudget,
        integrations.voicemailScript,
        integrations.transcription?.setting ?? null,
        integrations.month?.ceilingCents ?? null,
      ])}
      integrations={integrations}
      finishingLines={[
        finishingSentence('transcription', state.paidFinishing?.transcription),
        finishingSentence('classification', state.paidFinishing?.classification),
      ].filter((line): line is string => line !== null)}
      editable={state.mayMutate}
      notice={state.integrationsNotice ?? null}
      busy={busy}
      onSave={onSave}
    />
  );
}

function Loaded({
  integrations,
  finishingLines,
  editable,
  notice,
  busy,
  onSave,
}: {
  readonly integrations: IntegrationsSettingsResponse;
  /** Slice P1: "Transcription is off. 1 transcription already sent is finishing.", and the classifier's. */
  readonly finishingLines: readonly string[];
  readonly editable: boolean;
  readonly notice: string | null;
  busy(settingKey: SaveIntegrationInput['settingKey']): boolean;
  onSave(input: SaveIntegrationInput): void;
}): JSX.Element {
  const budget = integrations.telephonyBudget;
  // Kept above the route with the server value each edit began from (K2): an edit whose base
  // is no longer what the server holds is dropped, and a save sends the CURRENT server value
  // for every field that was not touched.
  const dollarsKept = useKeptBased('settings:calling:budget-dollars', (budget.dailyCeilingCents / 100).toFixed(2), sameNumber);
  const minutesKept = useKeptBased('settings:calling:minutes', String(budget.maxMinutesPerCall), sameNumber);
  const scriptKept = useKeptBased('settings:calling:voicemail', integrations.voicemailScript);
  const [dollars, setDollars] = [dollarsKept.value, dollarsKept.set] as const;
  const [minutes, setMinutes] = [minutesKept.value, minutesKept.set] as const;
  const [script, setScript] = [scriptKept.value, scriptKept.set] as const;

  const callingOn = integrations.callingProvider === 'twilio';
  const calcomOn = integrations.calendarIntegration === 'calcom';
  const setupMissing = !integrations.configured.twilioVoice.ok;
  const noBudget = budget.dailyCeilingCents <= 0;
  const callingReason = callingOn ? null : setupMissing ? CALLING_NEEDS_SETUP : noBudget ? CALLING_NEEDS_BUDGET : null;
  const calcomReason = calcomOn || integrations.configured.calcom.ok ? null : CALCOM_NEEDS_SECRET;

  const cents = centsFromDollars(dollars);
  const minutesValue = minutesFrom(minutes);
  const budgetIssue = cents === null ? BUDGET_RANGE : minutesValue === null ? MINUTES_RANGE : null;
  const budgetChanged = cents !== budget.dailyCeilingCents || minutesValue !== budget.maxMinutesPerCall;
  const scriptTrimmed = script.trim();
  const scriptChanged = scriptTrimmed !== integrations.voicemailScript;

  return (
    <Section data-testid="calling-calendar" title="Calling & calendar">
      <Rows>
        <Row data-testid="row-calling">
          <RowMain
            line="In-app calling"
            detail={
              <span data-testid="calling-detail">
                {callingReason ?? (callingOn ? 'Calls are placed from Callie.' : 'Calls open your phone app.')}
              </span>
            }
          />
          <input
            type="checkbox"
            role="switch"
            aria-label="In-app calling"
            data-testid="calling-switch"
            checked={callingOn}
            disabled={!editable || busy('calling_provider') || callingReason !== null}
            onChange={event => {
              onSave({ settingKey: 'calling_provider', value: { provider: event.target.checked ? 'twilio' : 'tel' } });
            }}
          />
        </Row>
        {callingOn && noBudget ? (
          <Row>
            <RowMain line={<span data-testid="calling-budget-warning" className="text-muted-foreground">{CALLING_NEEDS_BUDGET}</span>} />
          </Row>
        ) : null}

        <Row data-testid="row-budget" className="items-start">
          <RowMain
            line="Daily calling budget"
            detail={
              <span data-testid="budget-detail">
                {`Spent today ${money(integrations.spentTodayCents)}. Calls stop for the day when the budget is used.`}
              </span>
            }
          />
          <span className="flex shrink-0 flex-col items-end gap-1">
            <span className="flex items-center gap-1 text-sm">
              $
              <Input
                data-testid="budget-dollars"
                aria-label="Dollars per day"
                inputMode="decimal"
                autoComplete="off"
                className="h-7 w-20 text-right text-xs"
                disabled={!editable || busy('telephony_budget')}
                aria-invalid={cents === null}
                value={dollars}
                onChange={event => {
                  setDollars(event.target.value);
                }}
              />
              <span className="text-xs text-muted-foreground">a day</span>
              <Button
                size="sm"
                data-testid="budget-save"
                disabled={!editable || busy('telephony_budget') || budgetIssue !== null || !budgetChanged}
                onClick={() => {
                  if (cents === null || minutesValue === null) return;
                  onSave({
                    settingKey: 'telephony_budget',
                    value: {
                      dailyCeilingCents: cents,
                      maxMinutesPerCall: minutesValue,
                      unitPriceMicros: budget.unitPriceMicros,
                    },
                  });
                }}
              >
                Save
              </Button>
            </span>
            <ChangedElsewhere show={dollarsKept.elsewhere || minutesKept.elsewhere} />
            {budgetIssue === null ? null : (
              <span data-testid="budget-issue" className="text-xs text-destructive">
                {budgetIssue}
              </span>
            )}
          </span>
        </Row>
        <Row className="items-start">
          <details data-testid="budget-advanced" className="text-xs text-muted-foreground">
            <summary className="cursor-default">Advanced</summary>
            <label className="mt-1 flex items-center gap-2">
              Longest call, in minutes
              <Input
                data-testid="budget-minutes"
                aria-label="Longest call in minutes"
                inputMode="numeric"
                autoComplete="off"
                className="h-7 w-16 text-right text-xs"
                disabled={!editable || busy('telephony_budget')}
                aria-invalid={minutesValue === null}
                value={minutes}
                onChange={event => {
                  setMinutes(event.target.value);
                }}
              />
            </label>
            <p className="mt-1">Each call sets this much aside from the day’s budget before it is placed.</p>
          </details>
        </Row>

        <Row data-testid="row-voicemail" className="items-start">
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-sm">Voicemail script</span>
            <Textarea
              data-testid="voicemail-script"
              aria-label="Voicemail script"
              rows={4}
              maxLength={VOICEMAIL_TEMPLATE_MAX_CHARACTERS}
              disabled={!editable || busy('voicemail_script')}
              aria-invalid={scriptTrimmed === ''}
              value={script}
              onChange={event => {
                setScript(event.target.value);
              }}
            />
            <ChangedElsewhere show={scriptKept.elsewhere} />
            <span data-testid="voicemail-placeholders" className="text-xs text-muted-foreground">
              {`Filled in for each call: ${VOICEMAIL_PLACEHOLDERS.map(name => `{${name}}`).join(', ')}.`}
            </span>
          </span>
          <Button
            size="sm"
            data-testid="voicemail-save"
            disabled={!editable || busy('voicemail_script') || scriptTrimmed === '' || !scriptChanged}
            onClick={() => {
              onSave({ settingKey: 'voicemail_script', value: { template: scriptTrimmed } });
            }}
          >
            Save
          </Button>
        </Row>

        {integrations.transcription === undefined ? null : (
          <TranscriptionRows transcription={integrations.transcription} editable={editable} busy={busy} onSave={onSave} />
        )}

        {integrations.meetingAutoRecording===undefined?null:<MeetingAutoRecordingSection configuration={integrations.meetingAutoRecording} editable={editable} busy={busy('meeting_auto_recording')} onSave={value=>{onSave({settingKey:'meeting_auto_recording',value});}}/>}
        {integrations.meetingFollowThrough === undefined ? null : <MeetingFollowThroughSection configuration={integrations.meetingFollowThrough} editable={editable} busy={busy('meeting_follow_through')} onSave={value => { onSave({ settingKey: 'meeting_follow_through', value }); }} />}
        {integrations.meetingAnalysis === undefined ? null : <MeetingAnalysisSection setting={integrations.meetingAnalysis.setting} spentTodayCents={integrations.meetingAnalysis.spentTodayCents} editable={editable} busy={busy('meeting_analysis')} onSave={value => { onSave({ settingKey: 'meeting_analysis', value }); }} />}
        {integrations.meetingTranscription === undefined ? null : <MeetingTranscriptionSection setting={integrations.meetingTranscription.setting} spentTodayCents={integrations.meetingTranscription.spentTodayCents} editable={editable} busy={busy('meeting_transcription')} onSave={value => { onSave({ settingKey: 'meeting_transcription', value }); }} />}
        {integrations.month === undefined ? null : (
          <MonthRow month={integrations.month} editable={editable} busy={busy} onSave={onSave} />
        )}
        {finishingLines.map(line => (
          <p key={line} data-testid="paid-finishing" className="py-1 text-sm text-muted-foreground">
            {line}
          </p>
        ))}

        <Row data-testid="row-calcom">
          <RowMain
            line="Cal.com bookings"
            detail={
              <span data-testid="calcom-detail">
                {calcomReason ?? (calcomOn ? 'A booked demo moves the firm to Demo booked.' : 'Booked demos are not read.')}
              </span>
            }
          />
          <input
            type="checkbox"
            role="switch"
            aria-label="Cal.com bookings"
            data-testid="calcom-switch"
            checked={calcomOn}
            disabled={!editable || busy('calendar_integration') || calcomReason !== null}
            onChange={event => {
              onSave({ settingKey: 'calendar_integration', value: { integration: event.target.checked ? 'calcom' : 'off' } });
            }}
          />
        </Row>
      </Rows>
      {notice === null ? null : (
        <p data-testid="calling-calendar-notice" role="alert" className="mt-2 text-xs text-destructive">
          {reasonSentence(notice)}
        </p>
      )}
    </Section>
  );
}

/** Slice C2: "Transcribe calls" and the daily transcription budget, in dollars. */
function TranscriptionRows({
  transcription,
  editable,
  busy,
  onSave,
}: {
  readonly transcription: NonNullable<IntegrationsSettingsResponse['transcription']>;
  readonly editable: boolean;
  busy(settingKey: SaveIntegrationInput['settingKey']): boolean;
  onSave(input: SaveIntegrationInput): void;
}): JSX.Element {
  const setting = transcription.setting;
  const kept = useKeptBased('settings:calling:transcription-dollars', (setting.dailyCeilingCents / 100).toFixed(2), sameNumber);
  const [dollars, setDollars] = [kept.value, kept.set] as const;
  const on = setting.enabled;
  const keyMissing = !transcription.configured.ok;
  const noBudget = setting.dailyCeilingCents <= 0;
  const reason = on ? null : keyMissing ? TRANSCRIPTION_NEEDS_KEY : noBudget ? TRANSCRIPTION_NEEDS_BUDGET : null;
  const cents = transcriptionCentsFromDollars(dollars);
  const changed = cents !== setting.dailyCeilingCents;
  const saving = busy('call_transcription');
  return (
    <>
      <Row data-testid="row-transcription">
        <RowMain
          line="Transcribe calls"
          detail={
            <span data-testid="transcription-detail">
              {reason ??
                (on
                  ? 'Answered calls of at least 20 seconds are transcribed.'
                  : 'Calls are recorded but not transcribed.')}
            </span>
          }
        />
        <input
          type="checkbox"
          role="switch"
          aria-label="Transcribe calls"
          data-testid="transcription-switch"
          checked={on}
          disabled={!editable || saving || reason !== null}
          onChange={event => {
            onSave({ settingKey: 'call_transcription', value: { ...setting, enabled: event.target.checked } });
          }}
        />
      </Row>
      <Row data-testid="row-transcription-budget" className="items-start">
        <RowMain
          line="Daily transcription budget"
          detail={
            <span data-testid="transcription-budget-detail">
              {keyMissing
                ? TRANSCRIPTION_NEEDS_KEY
                : `Spent today ${money(transcription.spentTodayCents)}. Transcription stops for the day when the budget is used.`}
            </span>
          }
        />
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="flex items-center gap-1 text-sm">
            $
            <Input
              data-testid="transcription-budget-dollars"
              aria-label="Transcription dollars per day"
              inputMode="decimal"
              autoComplete="off"
              className="h-7 w-20 text-right text-xs"
              disabled={!editable || saving || keyMissing}
              aria-invalid={cents === null}
              value={dollars}
              onChange={event => {
                setDollars(event.target.value);
              }}
            />
            <span className="text-xs text-muted-foreground">a day</span>
            <Button
              size="sm"
              data-testid="transcription-budget-save"
              disabled={!editable || saving || keyMissing || cents === null || !changed}
              onClick={() => {
                if (cents === null) return;
                onSave({ settingKey: 'call_transcription', value: { ...setting, dailyCeilingCents: cents } });
              }}
            >
              Save
            </Button>
          </span>
          <ChangedElsewhere show={kept.elsewhere} />
          {cents === null ? (
            <span data-testid="transcription-budget-issue" className="text-xs text-destructive">
              {TRANSCRIPTION_BUDGET_RANGE}
            </span>
          ) : null}
        </span>
      </Row>
    </>
  );
}

/** Slice P1: the month-to-date cash limit, with what the month has cost so far. */
function MonthRow({
  month,
  editable,
  busy,
  onSave,
}: {
  readonly month: NonNullable<IntegrationsSettingsResponse['month']>;
  readonly editable: boolean;
  busy(settingKey: SaveIntegrationInput['settingKey']): boolean;
  onSave(input: SaveIntegrationInput): void;
}): JSX.Element {
  const kept = useKeptBased('settings:calling:month-dollars', (month.ceilingCents / 100).toFixed(2), sameNumber);
  const [dollars, setDollars] = [kept.value, kept.set] as const;
  const cents = monthCentsFromDollars(dollars);
  const saving = busy('monthly_cash_ceiling_cents');
  return (
    <Row data-testid="row-month" className="items-start">
      <RowMain
        line="Monthly spending limit"
        detail={
          <span className="flex flex-col">
            <span data-testid="month-detail">{monthLine(month)}</span>
            {month.creditsMonthCents === undefined ? null : <span data-testid="month-credits">{creditsLine(month.creditsMonthCents)}</span>}
          </span>
        }
      />
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="flex items-center gap-1 text-sm">
          $
          <Input
            data-testid="month-dollars"
            aria-label="Dollars per month"
            inputMode="decimal"
            autoComplete="off"
            className="h-7 w-20 text-right text-xs"
            disabled={!editable || saving}
            aria-invalid={cents === null}
            value={dollars}
            onChange={event => {
              setDollars(event.target.value);
            }}
          />
          <span className="text-xs text-muted-foreground">a month</span>
          <Button
            size="sm"
            data-testid="month-save"
            disabled={!editable || saving || cents === null || cents === month.ceilingCents}
            onClick={() => {
              if (cents === null) return;
              onSave({ settingKey: 'monthly_cash_ceiling_cents', value: { cents } });
            }}
          >
            Save
          </Button>
        </span>
        <ChangedElsewhere show={kept.elsewhere} />
        {cents === null ? (
          <span data-testid="month-issue" className="text-xs text-destructive">
            {MONTH_RANGE}
          </span>
        ) : null}
      </span>
    </Row>
  );
}
