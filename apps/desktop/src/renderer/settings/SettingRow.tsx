import { useState, type JSX } from 'react';
import type { ActiveSettingKey } from '../settingsContract.ts';
import {
  BUSINESS_ZONE_CHOICES,
  POSTAL_ADDRESS_MAX_LENGTH,
  inertSentence,
  settingFields,
  settingSummary,
  settingValueFrom,
  type AdminView,
  type SettingField,
  type SettingRowView,
} from '../settingsView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Field, Row, RowMain, Rows } from '../ui/layout.tsx';
import { Select } from '../ui/select.tsx';
import { Textarea } from '../ui/textarea.tsx';

/**
 * One workspace setting: what it is, what it says now, a typed control, a note and Save
 * (lane g88, audit G08).
 *
 * Editing a setting was a textarea of JSON until g88 — the founder was typing braces to
 * change a time zone — so each slice this build knows has typed controls, built from
 * `settingFields` and read back by `settingValueFrom`. A slice this build does *not*
 * know is still the JSON, so a slice the API gains is never uneditable.
 *
 * The change note is optional and a Save without one is never dropped: the bridge sends
 * "Changed on the Mac" so the server's history keeps one per version.
 *
 * `saving` is this row's own command, not the page's: pressing Save here waits for this
 * setting and leaves every other section of Administration alone.
 */

function Control({
  settingKey,
  field,
  editable,
  value,
  onChange,
}: {
  readonly settingKey: string;
  readonly field: SettingField;
  readonly editable: boolean;
  readonly value: string | boolean;
  onChange(next: string | boolean): void;
}): JSX.Element {
  const id = `field-${settingKey}-${field.key}`;
  if (field.kind === 'toggle') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          id={id}
          data-testid={id}
          disabled={!editable}
          checked={value === true}
          onChange={event => {
            onChange(event.target.checked);
          }}
        />
        {field.label}
      </label>
    );
  }
  if (field.kind === 'zone') {
    const text = typeof value === 'string' ? value : '';
    const known = BUSINESS_ZONE_CHOICES.some(choice => choice.value === text);
    return (
      <Field label={field.label} htmlFor={id}>
        <Select
          id={id}
          data-testid={id}
          disabled={!editable}
          value={text}
          onChange={event => {
            onChange(event.target.value);
          }}
        >
          {BUSINESS_ZONE_CHOICES.map(choice => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
          {/* A zone the list does not name is still what is in force, and is shown. */}
          {known ? null : <option value={text}>{text}</option>}
        </Select>
      </Field>
    );
  }
  return (
    <Field label={field.label} htmlFor={id} hint={field.hint}>
      <Input
        id={id}
        data-testid={id}
        type="text"
        autoComplete="off"
        disabled={!editable}
        {...(field.key === 'address' ? { maxLength: POSTAL_ADDRESS_MAX_LENGTH } : {})}
        value={typeof value === 'string' ? value : ''}
        onChange={event => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}

export function SettingRow({
  row,
  history,
  saving,
  onSave,
  onHistory,
}: {
  readonly row: SettingRowView;
  readonly history: AdminView['history'];
  /** This row's own Save is on the wire. */
  readonly saving: boolean;
  onSave(input: { readonly settingKey: ActiveSettingKey; readonly value: unknown; readonly changeNote: string }): void;
  onHistory(settingKey: ActiveSettingKey): void;
}): JSX.Element {
  const fields = settingFields(row.settingKey, row.value);
  const [values, setValues] = useState<Readonly<Record<string, string | boolean>>>(() =>
    Object.fromEntries((fields ?? []).map(field => [field.key, field.value])),
  );
  const [raw, setRaw] = useState(() => JSON.stringify(row.value, null, 2));
  const [unreadable, setUnreadable] = useState(false);
  const [note, setNote] = useState('');
  const summary = settingSummary(row.settingKey, row.value);
  const key = row.settingKey as ActiveSettingKey;

  return (
    <section data-testid={`setting-${row.settingKey}`} className="border-b border-border py-4 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{row.label}</h3>
        {summary === '' ? null : (
          <span data-testid={`summary-${row.settingKey}`} className="text-xs text-muted-foreground">
            {summary}
          </span>
        )}
      </div>

      <fieldset
        data-testid={`value-${row.settingKey}`}
        disabled={!row.editable || saving}
        {...(row.editable ? {} : { 'aria-disabled': true })}
        className="mt-2 flex flex-col gap-3"
      >
        {fields === null ? (
          <Textarea
            rows={4}
            data-testid={`json-editor-${row.settingKey}`}
            {...(unreadable ? { 'aria-invalid': true } : {})}
            value={raw}
            onChange={event => {
              setRaw(event.target.value);
              setUnreadable(false);
            }}
          />
        ) : (
          fields.map(field => (
            <Control
              key={field.key}
              settingKey={row.settingKey}
              field={field}
              editable={row.editable && !saving}
              value={values[field.key] ?? field.value}
              onChange={next => {
                setValues(current => ({ ...current, [field.key]: next }));
              }}
            />
          ))
        )}
      </fieldset>

      <div className="mt-3 flex items-center gap-2">
        <Input
          data-testid={`note-${row.settingKey}`}
          aria-label="Why (optional)"
          placeholder="Why (optional)"
          disabled={!row.editable || saving}
          value={note}
          onChange={event => {
            setNote(event.target.value);
          }}
          className="h-7 w-56 text-xs"
        />
        <Button
          size="sm"
          data-testid={`save-${row.settingKey}`}
          disabled={!row.editable || saving}
          {...(saving ? { 'aria-busy': true } : {})}
          onClick={() => {
            if (fields === null) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw);
              } catch {
                // Not a refusal from the server, so it is not a notice: the page marks
                // the value unreadable and sends nothing.
                setUnreadable(true);
                return;
              }
              onSave({ settingKey: key, value: parsed, changeNote: note });
              return;
            }
            const built = settingValueFrom(row.settingKey, values);
            if (!built.ok) return;
            onSave({ settingKey: key, value: built.value, changeNote: note });
          }}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="quiet"
          data-testid={`history-${row.settingKey}`}
          onClick={() => {
            onHistory(key);
          }}
        >
          History
        </Button>
      </div>

      {row.notEditableBecause === null ? null : (
        <p className="mt-2 text-xs text-muted-foreground">{inertSentence(row.notEditableBecause)}</p>
      )}

      <details data-testid={`details-${row.settingKey}`} className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-default">Details</summary>
        <p className="provenance">{row.provenance}</p>
        <pre data-testid={`json-${row.settingKey}`} className="mt-1 whitespace-pre-wrap">
          {JSON.stringify(row.value, null, 2)}
        </pre>
      </details>

      {history === null || history.settingKey !== row.settingKey ? null : (
        <div data-testid="setting-history" className="mt-3">
          <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{history.heading}</h4>
          <p data-testid="history-current" className="mt-1 text-xs">
            {history.currentLine}
          </p>
          <Rows className="mt-1">
            {history.versions.map(entry => (
              <Row key={entry.version} data-testid="history-version" className="items-start py-1">
                <RowMain
                  line={<span data-testid="history-line" className="text-xs">{entry.line}</span>}
                  detail={
                    <>
                      <span data-testid="history-from" className="block">{`From ${entry.from}`}</span>
                      <span data-testid="history-to" className="block">{`To ${entry.to}`}</span>
                    </>
                  }
                />
              </Row>
            ))}
          </Rows>
        </div>
      )}
    </section>
  );
}
