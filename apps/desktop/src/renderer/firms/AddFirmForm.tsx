import { useState, type JSX } from 'react';
import type { ImportColumn } from '@fss/contracts';
import { useClearDrafts, useClearUnchangedDrafts, useDrafts } from '../app/drafts.tsx';
import { ADD_FIRM_FIELDS, TIME_ZONE_CHOICES, addFirmSubmittable, fieldIssues, issueSentence } from '../captureView.ts';
import type { AddFirmDraft, AddFirmView } from '../firmWorkspaceContract.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Field } from '../ui/layout.tsx';
import { Select } from '../ui/select.tsx';

/**
 * The Add firm form (lane g84, audit item G02).
 *
 * The smallest complete way to get one firm in: its name, its website and its time zone,
 * and optionally the first person there with their title, email and phone. One press
 * sends one command, and the firm, the person and their address and number land together
 * or not at all. A firm added here is assigned to the person who added it and appears
 * under "Not in the pipeline yet"; its number is callable and its address is checked.
 *
 * Every field the server named carries its sentence underneath and `aria-invalid`.
 * Nothing is validated here but the one thing the button can see for itself — a firm with
 * no name — which is the server's rule too, said before the command is sent rather than
 * after.
 *
 * What is typed lives in the shell's draft store, so leaving the form and coming back
 * does not lose it, and a refused form's values are what an untouched field shows.
 */

const DRAFTS = 'addFirm:';

function issuesOf(view: AddFirmView, column: ImportColumn): readonly { readonly testId: string; readonly text: string }[] {
  return fieldIssues(view, column).map(text => ({ testId: `issue-${column}`, text }));
}

export function AddFirmForm({
  view,
  actionsEnabled,
  onSubmit,
  onCancel,
  onOpenFirm,
}: {
  readonly view: AddFirmView;
  readonly actionsEnabled: boolean;
  onSubmit(draft: AddFirmDraft, onAccepted: () => void): void;
  onCancel(): void;
  onOpenFirm(firmId: string): void;
}): JSX.Element {
  const clear = useClearDrafts();
  const clearUnchanged = useClearUnchangedDrafts();
  const { values, set } = useDrafts();
  const [nameMissing, setNameMissing] = useState(false);

  const valueOf = (key: keyof AddFirmDraft): string => values[`${DRAFTS}${key}`] ?? view.draft[key];
  const draft = (): AddFirmDraft => ({
    name: valueOf('name'),
    website: valueOf('website'),
    timeZone: valueOf('timeZone'),
    contactName: valueOf('contactName'),
    contactTitle: valueOf('contactTitle'),
    contactEmail: valueOf('contactEmail'),
    contactPhone: valueOf('contactPhone'),
  });

  const timeZone = valueOf('timeZone');
  const zoneIssues = issuesOf(view, 'time_zone');
  const known = TIME_ZONE_CHOICES.some(choice => choice.value === timeZone);

  const textField = (spec: (typeof ADD_FIRM_FIELDS)[number]): JSX.Element => {
    const issues = [
      ...issuesOf(view, spec.column),
      ...(spec.key === 'name' && nameMissing ? [{ testId: 'issue-firm_name', text: issueSentence('firm_name_missing') }] : []),
    ];
    return (
      <Field key={spec.key} label={spec.label} htmlFor={`add-firm-${spec.key}`} issues={issues}>
        <Input
          id={`add-firm-${spec.key}`}
          data-testid={`add-firm-${spec.key}`}
          type={spec.key === 'contactEmail' ? 'email' : spec.key === 'contactPhone' ? 'tel' : 'text'}
          autoComplete="off"
          maxLength={spec.maxLength}
          disabled={!actionsEnabled}
          {...(spec.placeholder === '' ? {} : { placeholder: spec.placeholder })}
          {...(issues.length > 0 ? { 'aria-invalid': true } : {})}
          value={valueOf(spec.key)}
          onChange={event => {
            set(`${DRAFTS}${spec.key}`, event.target.value);
          }}
        />
      </Field>
    );
  };

  return (
    <form
      data-testid="add-firm-form"
      noValidate
      className="mt-6 flex flex-col gap-5"
      onSubmit={event => {
        event.preventDefault();
        const typed = draft();
        if (!addFirmSubmittable(typed.name, actionsEnabled)) {
          setNameMissing(true);
          return;
        }
        setNameMissing(false);
        // A refusal (or a lost answer) is still an unsaved draft. Keep it across
        // navigation, and only clear accepted values that have not since been edited.
        const submitted = Object.fromEntries(Object.entries(typed).map(([key, value]) => [`${DRAFTS}${key}`, value]));
        for (const [key, value] of Object.entries(submitted)) set(key, value);
        onSubmit(typed, () => clearUnchanged(submitted));
      }}
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Firm</legend>
        {ADD_FIRM_FIELDS.slice(0, 2).map(textField)}
        <Field label="Time zone" htmlFor="add-firm-timeZone" issues={zoneIssues}>
          <Select
            id="add-firm-timeZone"
            data-testid="add-firm-timeZone"
            disabled={!actionsEnabled}
            {...(zoneIssues.length > 0 ? { 'aria-invalid': true } : {})}
            value={timeZone}
            onChange={event => {
              set(`${DRAFTS}timeZone`, event.target.value);
            }}
          >
            {TIME_ZONE_CHOICES.map(choice => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
            {/* A zone the list does not name, from a draft the server refused, is still shown. */}
            {known ? null : <option value={timeZone}>{timeZone}</option>}
          </Select>
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          First contact (optional)
        </legend>
        {ADD_FIRM_FIELDS.slice(2).map(textField)}
      </fieldset>

      <div className="flex items-center gap-2">
        <Button type="submit" data-testid="add-firm-submit" disabled={!actionsEnabled}>
          Add firm
        </Button>
        <Button
          variant="quiet"
          data-testid="add-firm-cancel"
          onClick={() => {
            clear(DRAFTS);
            onCancel();
          }}
        >
          Cancel
        </Button>
        {view.duplicateFirmId === null ? null : (
          <Button
            variant="outline"
            data-testid="add-firm-open-duplicate"
            onClick={() => {
              const firmId = view.duplicateFirmId;
              if (firmId === null) return;
              clear(DRAFTS);
              onOpenFirm(firmId);
            }}
          >
            Open the firm already here
          </Button>
        )}
      </div>
    </form>
  );
}
