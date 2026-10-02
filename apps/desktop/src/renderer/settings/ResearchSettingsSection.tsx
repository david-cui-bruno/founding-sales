import type { JSX } from 'react';
import type { ResearchSettingsEdit, ResearchState } from '../researchContract.ts';
import { dollars, researchNotice, spendLine } from '../researchView.ts';
import { finishingSentence } from '../settingsView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { useKeptBased } from '../replies/kept.ts';
import { ChangedElsewhere } from './FormNotice.tsx';
import { Section } from './Group.tsx';

/**
 * Settings › Research: the ceilings, the model, and what has been spent (lane R).
 *
 * **Absent rather than inert for anyone who is not an admin.** `/research/settings`
 * answers a salesperson a refusal — the read *is* the workspace's budget — and the
 * bridge hands the page `settings: null` rather than a shape to render, so the
 * section is simply not there. That is `SendingSection.tsx`'s rule: a control that
 * exists only to be refused teaches nothing.
 *
 * **Nothing is clamped here.** A value outside the bounds comes back as a refusal an
 * admin reads, not a silent maximum; the page does not pre-empt the server's answer.
 *
 * **The model is shown and not editable.** v1 admits one model, because `pricing.ts`
 * has one reviewed price row and a run that cannot be priced cannot be cleared. A
 * select with one option would be a control that does nothing.
 */

const FIELDS = [
  { key: 'dailyFirmCeiling', label: 'Firms a day' },
  { key: 'dailyCostCeilingCents', label: 'Cents a day' },
  { key: 'monthlyCostCeilingCents', label: 'Cents a month' },
  { key: 'maxPagesPerFirm', label: 'Pages per firm' },
] as const;

export function ResearchSettingsSection({
  state,
  saving,
  onSave,
}: {
  readonly state: ResearchState | null;
  /** Whether this section's own Save is on the wire (P1-4). */
  readonly saving: boolean;
  onSave(edit: ResearchSettingsEdit): void;
}): JSX.Element | null {
  const settings = state?.settings ?? null;
  // Typed and not yet saved: kept above the route, per field, each with the saved value it
  // began from (K2). A field nobody touched is sent as the CURRENT saved value.
  const firms = useKeptBased('settings:research:dailyFirmCeiling', settings === null ? null : String(settings.dailyFirmCeiling));
  const day = useKeptBased('settings:research:dailyCostCeilingCents', settings === null ? null : String(settings.dailyCostCeilingCents));
  const month = useKeptBased('settings:research:monthlyCostCeilingCents', settings === null ? null : String(settings.monthlyCostCeilingCents));
  const pages = useKeptBased('settings:research:maxPagesPerFirm', settings === null ? null : String(settings.maxPagesPerFirm));
  const kept: Readonly<Record<string, ReturnType<typeof useKeptBased>>> = {
    dailyFirmCeiling: firms,
    dailyCostCeilingCents: day,
    monthlyCostCeilingCents: month,
    maxPagesPerFirm: pages,
  };
  if (settings === null) return null;
  const spend = spendLine(state as ResearchState);
  const finishingLine = finishingSentence('research', state?.finishing);

  const numberOf = (key: string, current: number): number => {
    const typed = kept[key]?.touched === true ? kept[key].value : '';
    if (typed.trim() === '') return current;
    const parsed = Number(typed);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : current;
  };

  return (
    <Section data-testid="research-settings" title="Research">
      {state?.notice == null ? null : (
        <p data-testid="research-settings-notice" className="py-1 text-sm text-muted-foreground">
          {researchNotice(state.notice)}
        </p>
      )}

      <label className="flex items-center gap-2 py-1 text-sm">
        <input
          type="checkbox"
          data-testid="research-enabled"
          disabled={saving}
          checked={settings.enabled}
          onChange={event => {
            onSave({ enabled: event.target.checked });
          }}
        />
        Read each firm’s own website
      </label>
      {finishingLine === null ? null : (
        <p data-testid="research-finishing" className="py-1 text-sm text-muted-foreground">
          {finishingLine}
        </p>
      )}

      <div className="mt-2 flex flex-col gap-2">
        {FIELDS.map(field => (
          <label key={field.key} className="flex items-center gap-2 text-sm">
            <span className="w-36 text-muted-foreground">{field.label}</span>
            <Input
              data-testid={`research-${field.key}`}
              inputMode="numeric"
              disabled={saving}
              value={kept[field.key]?.value ?? ''}
              onChange={event => {
                kept[field.key]?.set(event.target.value);
              }}
            />
          </label>
        ))}
      </div>

      <ChangedElsewhere show={Object.values(kept).some(entry => entry.elsewhere)} />
      <div className="mt-3 flex items-center gap-3">
        <Button
          size="sm"
          data-testid="research-save"
          disabled={saving}
          {...(saving ? { 'aria-busy': true } : {})}
          onClick={() => {
            onSave({
              dailyFirmCeiling: numberOf('dailyFirmCeiling', settings.dailyFirmCeiling),
              dailyCostCeilingCents: numberOf('dailyCostCeilingCents', settings.dailyCostCeilingCents),
              monthlyCostCeilingCents: numberOf('monthlyCostCeilingCents', settings.monthlyCostCeilingCents),
              maxPagesPerFirm: numberOf('maxPagesPerFirm', settings.maxPagesPerFirm),
            });
            for (const entry of Object.values(kept)) entry.clear();
          }}
        >
          Save
        </Button>
        <span data-testid="research-model" className="text-xs text-muted-foreground">
          {settings.modelName}
          {state?.worstCaseRunCents == null ? '' : ` · up to ${dollars(state.worstCaseRunCents)} a firm`}
        </span>
      </div>

      {spend === null ? null : (
        <p data-testid="research-spend" className="mt-2 text-sm text-muted-foreground">
          {spend}
        </p>
      )}
    </Section>
  );
}
