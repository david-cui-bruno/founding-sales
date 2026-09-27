import { useEffect, useState, type JSX } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { DraftStep, SequenceState, SequenceVersion, TemplateVersion } from '../sequenceContract.ts';
import {
  CHANNEL_LABELS,
  EDITOR_CHANNELS,
  NO_ANSWER_LABELS,
  draftChanged,
  draftIssues,
  draftStepsOf,
  moveStep,
  newStep,
  removeStep,
  replaceStep,
  suggestedPlan,
  type VersionPanel,
} from '../sequenceView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Row, RowActions, Rows } from '../ui/layout.tsx';
import { Select } from '../ui/select.tsx';

/**
 * The step editor (lane g88, audit G03; wave 2, S3).
 *
 * Every step of the version as typed controls — its channel, when it is due, the template
 * an email sends or what a call does when nobody answers — with up, down and remove on
 * hover, and Add call / Add email below. Nothing is sent until Save.
 *
 * **A published version is edited in place.** `saveSteps` changes it and the change
 * reaches the enrollments already running in it, which is what a person editing a
 * sequence means; the "Edit as a new draft" it used to offer made a second version that
 * nobody in the first one ever saw. The server holds a published version to what
 * publication checks, and refuses a step that has already run.
 *
 * The steps being edited are held here, between answers, because every answer redraws
 * the view and an editor redrawn from the server's copy would drop what was being typed.
 * They are forgotten once saved, and whenever the version on screen changes.
 */

function templateLabel(template: TemplateVersion): string {
  const state = template.retiredAt !== null ? ' (retired)' : template.approvedAt === null ? ' (not approved yet)' : '';
  return `${template.name} v${String(template.version)}${state}`;
}

export function StepEditor({
  panel,
  version,
  state,
  saving,
  onSave,
}: {
  readonly panel: VersionPanel;
  readonly version: SequenceVersion;
  readonly state: SequenceState;
  /** This version's own Save is on the wire; another version's is not this one's wait. */
  readonly saving: boolean;
  onSave(steps: readonly DraftStep[]): void;
}): JSX.Element {
  const [steps, setSteps] = useState<readonly DraftStep[]>(() => draftStepsOf(version));
  const stored = JSON.stringify(draftStepsOf(version));
  useEffect(() => {
    // The version answered with different steps — somebody saved, here or elsewhere — so
    // what is on screen is no longer an edit of it.
    setSteps(JSON.parse(stored) as readonly DraftStep[]);
  }, [stored]);

  const issues = draftIssues(steps);
  const changed = draftChanged(version, steps);

  return (
    <div className="mt-2">
      <Rows data-testid="version-steps">
        {steps.map((step, index) => (
          // The index is the step's identity here: a step has no id until it is saved,
          // and reordering is exactly what this list is for.
          <Row key={index} data-testid="step" className="items-center">
            <span data-testid="step-number" className="w-14 shrink-0 text-xs text-muted-foreground">
              {`Step ${String(index + 1)}`}
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <Select
                data-testid="step-channel-select"
                aria-label="Channel"
                disabled={!panel.editable}
                value={step.channel}
                onChange={event => {
                  const value = event.target.value;
                  if (value !== 'email' && value !== 'call_task') return;
                  setSteps(current => replaceStep(current, index, { ...newStep(value, []), delay: step.delay }));
                }}
                className="h-7 w-24 text-xs"
              >
                {EDITOR_CHANNELS.map(channel => (
                  <option key={channel} value={channel}>
                    {CHANNEL_LABELS[channel]}
                  </option>
                ))}
              </Select>
              <Input
                type="number"
                data-testid="step-delay-amount"
                aria-label="After"
                min={0}
                max={step.delay.unit === 'elapsed' ? 8760 : 365}
                step={1}
                disabled={!panel.editable}
                value={String(step.delay.unit === 'elapsed' ? step.delay.hours : step.delay.days)}
                onChange={event => {
                  const amount = Number(event.target.value);
                  setSteps(current =>
                    replaceStep(current, index, {
                      ...step,
                      delay: step.delay.unit === 'elapsed' ? { unit: 'elapsed', hours: amount } : { unit: 'business_days', days: amount },
                    }),
                  );
                }}
                className="h-7 w-16 text-xs"
              />
              <Select
                data-testid="step-delay-unit"
                aria-label="Counted in"
                disabled={!panel.editable}
                value={step.delay.unit}
                onChange={event => {
                  const amount = step.delay.unit === 'elapsed' ? step.delay.hours : step.delay.days;
                  const unit = event.target.value;
                  setSteps(current =>
                    replaceStep(current, index, {
                      ...step,
                      delay: unit === 'elapsed' ? { unit: 'elapsed', hours: amount } : { unit: 'business_days', days: amount },
                    }),
                  );
                }}
                className="h-7 w-56 text-xs"
              >
                <option value="business_days">business days after enrollment</option>
                <option value="elapsed">hours after enrollment</option>
              </Select>
              {step.channel === 'email' ? (
                <Select
                  data-testid="step-template"
                  aria-label="Template"
                  disabled={!panel.editable}
                  value={step.templateVersionId ?? ''}
                  onChange={event => {
                    const value = event.target.value;
                    setSteps(current => replaceStep(current, index, { ...step, templateVersionId: value === '' ? null : value }));
                  }}
                  className="h-7 w-56 text-xs"
                >
                  <option value="">Choose a template…</option>
                  {state.templates
                    .filter(template => template.retiredAt === null || template.id === step.templateVersionId)
                    .map(template => (
                      <option key={template.id} value={template.id}>
                        {templateLabel(template)}
                      </option>
                    ))}
                </Select>
              ) : (
                <Select
                  data-testid="step-no-answer"
                  aria-label="On no answer"
                  disabled={!panel.editable}
                  value={step.onNoAnswer ?? 'advance'}
                  onChange={event => {
                    const value = event.target.value;
                    if (value !== 'advance' && value !== 'retry_call') return;
                    setSteps(current => replaceStep(current, index, { ...step, onNoAnswer: value }));
                  }}
                  className="h-7 w-56 text-xs"
                >
                  {(['advance', 'retry_call'] as const).map(value => (
                    <option key={value} value={value}>
                      {NO_ANSWER_LABELS[value]}
                    </option>
                  ))}
                </Select>
              )}
              {(() => {
                const chosen = step.templateVersionId === null ? null : state.templates.find(one => one.id === step.templateVersionId);
                if (step.channel !== 'email' || chosen === null || chosen === undefined) return null;
                if (chosen.approvedAt !== null && chosen.retiredAt === null) return null;
                return (
                  <span data-testid="step-problem" className="text-xs text-muted-foreground">
                    {chosen.retiredAt !== null ? 'That template is retired.' : 'Approve this template before publishing.'}
                  </span>
                );
              })()}
            </span>
            <RowActions>
              <Button
                variant="quiet"
                size="icon"
                aria-label="Move up"
                data-testid="step-up"
                disabled={!panel.editable || index === 0}
                onClick={() => {
                  setSteps(current => moveStep(current, index, -1));
                }}
              >
                <ArrowUp aria-hidden />
              </Button>
              <Button
                variant="quiet"
                size="icon"
                aria-label="Move down"
                data-testid="step-down"
                disabled={!panel.editable || index === steps.length - 1}
                onClick={() => {
                  setSteps(current => moveStep(current, index, 1));
                }}
              >
                <ArrowDown aria-hidden />
              </Button>
              <Button
                variant="quiet"
                size="icon"
                aria-label="Remove"
                data-testid="step-remove"
                disabled={!panel.editable}
                onClick={() => {
                  setSteps(current => removeStep(current, index));
                }}
              >
                <X aria-hidden />
              </Button>
            </RowActions>
          </Row>
        ))}
      </Rows>

      <div className="mt-3 flex items-center gap-1">
        {steps.length === 0 ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="step-suggested"
            disabled={!panel.editable}
            onClick={() => {
              setSteps(suggestedPlan(state.templates));
            }}
          >
            Start from the suggested plan
          </Button>
        ) : null}
        {EDITOR_CHANNELS.map(channel => (
          <Button
            key={channel}
            size="sm"
            variant="outline"
            data-testid={`step-add-${channel}`}
            disabled={!panel.editable}
            onClick={() => {
              setSteps(current => [...current, newStep(channel, current)]);
            }}
          >
            {`Add ${CHANNEL_LABELS[channel].toLowerCase()}`}
          </Button>
        ))}
      </div>
      {steps.length === 0 ? (
        <p data-testid="step-suggested-hint" className="mt-1 text-xs text-muted-foreground">
          The suggested plan is a call the day they are enrolled, an email two business days later, and a second call two
          business days after that. You can change every step before saving.
        </p>
      ) : null}

      <div data-testid="draft-issues" className="mt-2 flex flex-col gap-0.5 empty:hidden">
        {issues.map(issue => (
          <p key={issue.text} className="text-xs text-destructive">
            {issue.text}
          </p>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-1">
        <Button
          size="sm"
          data-testid="draft-save"
          disabled={!panel.editable || !changed || issues.length > 0 || saving}
          {...(saving ? { 'aria-busy': true } : {})}
          onClick={() => {
            onSave(steps);
          }}
        >
          Save
        </Button>
        {changed ? (
          <Button
            size="sm"
            variant="quiet"
            data-testid="draft-discard"
            onClick={() => {
              setSteps(draftStepsOf(version));
            }}
          >
            Discard changes
          </Button>
        ) : null}
      </div>
    </div>
  );
}
