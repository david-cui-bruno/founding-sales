import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { FirmBasicsAnswer, OperationInput } from '../../shared/operations.ts';
import { useClearDrafts, useDraft } from '../app/drafts.tsx';
import { cn } from '../lib/utils.ts';
import { reasonSentence } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Select } from '../ui/select.tsx';
import { dense } from '../v2/parts.tsx';

/**
 * A firm's calling basics — number, city, state, time zone — edited in place (slice S2).
 *
 * The same form on Today (under the firm's name, and from the call panel's "Add a phone
 * number") and on the firm page, so there is one set of words and one way the fields are
 * checked: by the server (`POST /crm/firms/basics`), which names every field at fault and
 * writes nothing when any is. What was typed is a draft above the route (`app/drafts.tsx`),
 * so moving to another firm or view and back keeps it.
 *
 * Only the fields that changed are sent. A number replaces the one shown (the old one is
 * retired, never deleted); a time zone left on "From the state" is the state's own zone
 * under the versioned rule, and a state that spans two zones asks for one.
 */

export interface BasicsValues {
  readonly locality: string | null;
  readonly regionCode: string | null;
  readonly timeZone: string | null;
}

export type BasicsField = 'phone' | 'locality' | 'regionCode' | 'timeZone';

/** The zones a US firm is in, by the name a person knows them by. */
export const US_TIME_ZONES: readonly { readonly zone: string; readonly label: string }[] = [
  { zone: 'America/New_York', label: 'Eastern (New York)' },
  { zone: 'America/Chicago', label: 'Central (Chicago)' },
  { zone: 'America/Denver', label: 'Mountain (Denver)' },
  { zone: 'America/Phoenix', label: 'Arizona (Phoenix)' },
  { zone: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { zone: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { zone: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
];

const ISSUE_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  phone_invalid: 'That is not a phone number Callie can dial. Ten digits, or + and the country code.',
  region_code_invalid: 'Use the two-letter state code, like TX.',
  time_zone_invalid: 'Pick a time zone from the list.',
  too_long: 'That is too long.',
});

/** What a refusal says when it names no field. */
export function basicsRefusalSentence(reason: string): string {
  if (reason === 'not_assigned') return 'This firm is somebody else’s; only they or an admin can change it.';
  if (reason === 'firm_unknown' || reason === 'firm_merged') return 'Callie cannot find this firm any more.';
  if (reason === 'offline') return 'Callie is offline. Nothing was saved; your edits are kept here.';
  return reasonSentence(reason);
}

export function BasicsEditor({
  firmId,
  values,
  phone,
  focus,
  enabled,
  onSaved,
  onCancel,
  save = async input => {
    const api = globalThis.callieApi;
    if (api === undefined) return { saved: null, reason: 'offline', issues: [] };
    return await api.command('firms.saveBasics', input);
  },
}: {
  readonly firmId: string;
  readonly values: BasicsValues;
  /** The number shown on the card today, which a new one replaces; null when there is none. */
  readonly phone: { readonly routeId: string; readonly e164: string } | null;
  /** The field to put the cursor in: the one the card said was missing. */
  readonly focus?: BasicsField | undefined;
  readonly enabled: boolean;
  onSaved(answer: FirmBasicsAnswer): void;
  onCancel(): void;
  readonly save?: (input: OperationInput<'firms.saveBasics'>) => Promise<FirmBasicsAnswer>;
}): JSX.Element {
  const prefix = `firm-basics:${firmId}:`;
  const [phoneDraft, setPhone] = useDraft(`${prefix}phone`, phone?.e164 ?? '');
  const [locality, setLocality] = useDraft(`${prefix}locality`, values.locality ?? '');
  const [regionCode, setRegion] = useDraft(`${prefix}regionCode`, values.regionCode ?? '');
  const [timeZone, setZone] = useDraft(`${prefix}timeZone`, values.timeZone ?? '');
  const clear = useClearDrafts();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<FirmBasicsAnswer | null>(null);
  const ids = { phone: useId(), locality: useId(), regionCode: useId(), timeZone: useId() };
  const first = useRef<HTMLInputElement>(null);
  const firstLocation = useRef<HTMLInputElement>(null);
  const state = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLSelectElement>(null);

  // The cursor goes to the field the card said was missing.
  useEffect(() => {
    const target = { phone: first, locality: firstLocation, regionCode: state, timeZone: zone }[focus ?? 'phone'];
    if (focus !== undefined) target.current?.focus();
  }, [focus]);

  const issueFor = (field: BasicsField): string | null => {
    const issue = answer?.issues.find(entry => entry.field === field);
    return issue === undefined ? null : (ISSUE_SENTENCES[issue.code] ?? issue.code);
  };

  const changed = {
    phone: phoneDraft.trim() !== '' && phoneDraft.trim() !== (phone?.e164 ?? ''),
    locality: locality.trim() !== (values.locality ?? ''),
    regionCode: regionCode.trim().toUpperCase() !== (values.regionCode ?? ''),
    timeZone: timeZone !== '' && timeZone !== (values.timeZone ?? ''),
  };
  const dirty = Object.values(changed).some(Boolean);

  const submit = (): void => {
    if (!dirty || busy) return;
    setBusy(true);
    const input = {
      firmId,
      ...(changed.phone
        ? { phone: { number: phoneDraft.trim(), ...(phone === null ? {} : { replacesRouteId: phone.routeId }) } }
        : {}),
      ...(changed.locality ? { locality: locality.trim() === '' ? null : locality.trim() } : {}),
      ...(changed.regionCode ? { regionCode: regionCode.trim() === '' ? null : regionCode.trim().toUpperCase() } : {}),
      ...(changed.timeZone ? { timeZone } : {}),
    };
    void save(input)
      .then(result => {
        setAnswer(result);
        if (result.saved !== null) {
          clear(prefix);
          onSaved(result);
        }
      }, () => {
        setAnswer({ saved: null, reason: 'offline', issues: [] });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const general = answer !== null && answer.saved === null && answer.issues.length === 0 && answer.reason !== null ? basicsRefusalSentence(answer.reason) : null;
  const zones = values.timeZone !== null && !US_TIME_ZONES.some(entry => entry.zone === values.timeZone)
    ? [...US_TIME_ZONES, { zone: values.timeZone, label: values.timeZone }]
    : US_TIME_ZONES;

  const field = (name: BasicsField, label: string, control: JSX.Element): JSX.Element => {
    const issue = issueFor(name);
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={ids[name]} className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        {control}
        {issue === null ? null : (
          <p data-testid={`basics-issue-${name}`} role="alert" className="text-xs text-danger-ink">
            {issue}
          </p>
        )}
      </div>
    );
  };

  return (
    <form
      data-testid="basics-editor"
      className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3"
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        {field(
          'phone',
          'Phone',
          <Input
            ref={first}
            id={ids.phone}
            data-testid="basics-phone"
            type="tel"
            value={phoneDraft}
            placeholder="(214) 555-0100"
            onChange={event => setPhone(event.target.value)}
            className={cn('h-7 border-strong font-mono text-sm', issueFor('phone') !== null && 'border-destructive')}
          />,
        )}
        {field(
          'locality',
          'City',
          <Input
            ref={firstLocation}
            id={ids.locality}
            data-testid="basics-locality"
            value={locality}
            placeholder="Dallas"
            onChange={event => setLocality(event.target.value)}
            className="h-7 border-strong text-sm"
          />,
        )}
        {field(
          'regionCode',
          'State',
          <Input
            ref={state}
            id={ids.regionCode}
            data-testid="basics-region"
            value={regionCode}
            maxLength={2}
            placeholder="TX"
            onChange={event => setRegion(event.target.value.toUpperCase())}
            className={cn('h-7 border-strong text-sm uppercase', issueFor('regionCode') !== null && 'border-destructive')}
          />,
        )}
        {field(
          'timeZone',
          'Time zone',
          <Select
            ref={zone}
            id={ids.timeZone}
            data-testid="basics-zone"
            value={timeZone}
            onChange={event => setZone(event.target.value)}
            className="h-7 border-strong text-sm"
          >
            <option value="">{values.timeZone === null ? 'From the state' : 'Keep as it is'}</option>
            {zones.map(entry => (
              <option key={entry.zone} value={entry.zone}>
                {entry.label}
              </option>
            ))}
          </Select>,
        )}
      </div>
      {phone === null || !changed.phone ? null : (
        <p className="text-xs text-muted-foreground">The new number replaces {phone.e164}, which is kept on the firm as retired.</p>
      )}
      {general === null ? null : (
        <p data-testid="basics-refused" role="alert" className="text-xs text-danger-ink">
          {general}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" data-testid="basics-save" className={dense.md} disabled={!enabled || !dirty || busy} {...(busy ? { 'aria-busy': true } : {})}>
          Save
        </Button>
        <Button type="button" variant="ghost" className={dense.md} onClick={onCancel}>
          Cancel
        </Button>
        <span className="ml-auto text-xs text-faint">Esc to close</span>
      </div>
    </form>
  );
}
