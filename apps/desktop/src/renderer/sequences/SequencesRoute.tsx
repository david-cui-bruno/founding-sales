import { useState, type JSX } from 'react';
import type { Generation } from '../app/generation.ts';
import type { SequenceReadSlice, SequenceState, TemplateVersion } from '../sequenceContract.ts';
import { sequenceScreen, typedBodyOf, type SequenceScreen } from '../sequenceView.ts';
import { Alert } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Page, Row, RowActions, RowMain, Rows, Section, Tag, Unread, ViewHeader } from '../ui/layout.tsx';
import { StepEditor } from './StepEditor.tsx';
import { TemplateForm } from './TemplateForm.tsx';
import { useSequences } from './useSequences.ts';

/**
 * Sequences (specification 11.1, 4.3, 14.2).
 *
 * The plans, the steps of the one on screen, and the emails they send. Every decision
 * comes from `sequenceView.ts`, so a control that is shown and a control that works
 * cannot disagree, and the page holds no rule of its own.
 *
 * Refusals are rendered rather than hidden, because a disabled button with no explanation
 * is the worst of both: a version that cannot be published says which reason applies, and
 * a save that could not be approved lists every issue the server named (12.6).
 *
 * The long-hold review went with the seven-day review itself (wave 2, S4.1): an
 * enrollment held that long resumes on its own, so the enrollments here are a count
 * per version — who is in flight — and there is nothing to confirm about any of them.
 */

const PUBLISH_REFUSAL_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  version_has_no_steps: 'Add at least one step before publishing.',
  ordinals_not_contiguous: 'The steps are numbered with a gap. Renumber them 1, 2, 3.',
  email_step_needs_approved_template: 'An email step names a template version that is not approved.',
  not_a_draft: 'This version is already published.',
  admin_only: 'Publishing a sequence is an administrator action.',
  upgrade_required: 'Update Callie to publish.',
});

function UnreadSlice({ screen, slice, onRetry }: { readonly screen: SequenceScreen; readonly slice: SequenceReadSlice; onRetry(): void }): JSX.Element | null {
  const unread = screen.unread.find(entry => entry.slice === slice);
  if (unread === undefined) return null;
  return (
    <Unread
      line={unread.line}
      testId={`sequence-unread-${slice}`}
      retryTestId={`sequence-retry-${slice}`}
      onRetry={onRetry}
    />
  );
}

function TemplatePanels({
  screen,
  state,
  onEdit,
  onNew,
  editingId,
}: {
  readonly screen: SequenceScreen;
  readonly state: SequenceState;
  readonly editingId: string | null;
  onEdit(template: TemplateVersion): void;
  onNew(): void;
}): JSX.Element {
  return (
    <Section
      title="Templates"
      count={screen.templates.length}
      actions={
        editingId === null ? (
          <Button size="sm" variant="outline" data-testid="template-new" disabled={!screen.canAuthor} onClick={onNew}>
            New template
          </Button>
        ) : undefined
      }
    >
      <Rows>
        {screen.templates.map(panel => {
          const template = state.templates.find(entry => entry.id === panel.id);
          return (
            <Row key={panel.id} data-testid="template" className="items-start py-2">
              <RowMain
                line={
                  <span className="flex items-center gap-2">
                    <span data-testid="template-label">{panel.label}</span>
                    <Tag data-testid="template-status" tone={panel.retired ? 'none' : panel.approved ? 'ok' : 'warn'}>
                      {panel.retired ? 'Retired' : panel.approved ? 'Approved' : 'Not approved'}
                    </Tag>
                  </span>
                }
                detail={
                  <>
                    <span data-testid="template-subject" className="block">
                      {panel.subject}
                    </span>
                    {panel.footerPresent ? null : (
                      <span data-testid="template-problem" className="block text-destructive">
                        The email does not end with the sign-off.
                      </span>
                    )}
                    {panel.optOutLinkMentioned ? (
                      <span data-testid="template-problem" className="block text-destructive">
                        The text carries an opt-out link. Callie takes a stop request in ordinary language instead.
                      </span>
                    ) : null}
                    <details data-testid="template-details" className="mt-1">
                      <summary className="cursor-default text-muted-foreground">Details</summary>
                      <pre data-testid="template-body" className="mt-1 text-xs whitespace-pre-wrap">
                        {panel.body}
                      </pre>
                      <p className="mt-1">Footer block:</p>
                      <pre data-testid="template-footer" className="text-xs whitespace-pre-wrap">
                        {panel.footer}
                      </pre>
                      <p className="mt-1">
                        Content hash: <code data-testid="template-hash">{panel.contentHash}</code>
                      </p>
                      {template === undefined ? null : (
                        <p>
                          {`Variables: ${template.requiredVariables.length === 0 ? 'none' : template.requiredVariables.join(', ')}`}
                        </p>
                      )}
                    </details>
                  </>
                }
              />
              {template === undefined || !screen.canAuthor || panel.retired ? null : (
                <RowActions>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="template-edit"
                    onClick={() => {
                      onEdit(template);
                    }}
                  >
                    Edit
                  </Button>
                </RowActions>
              )}
            </Row>
          );
        })}
      </Rows>
    </Section>
  );
}

export function SequencesRoute({
  identity,
  generation,
  guard,
}: {
  readonly identity: string | null;
  readonly generation: number;
  readonly guard: Generation;
}): JSX.Element {
  const sequences = useSequences(identity, generation, guard);
  const state = sequences.state;
  const [name, setName] = useState('');
  const [nameMissing, setNameMissing] = useState(false);
  const [editing, setEditing] = useState<{
    readonly templateVersionId: string;
    readonly name: string;
    readonly subject: string;
    readonly body: string;
    readonly signOff: string;
    readonly note: string | null;
  } | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  if (!sequences.available || state === null) {
    return (
      <Page>
        <ViewHeader title="Sequences" />
        {sequences.available ? null : (
          <p data-testid="sequences-unavailable" className="mt-6 text-sm text-muted-foreground">
            Callie cannot reach the rest of the app from this window.
          </p>
        )}
      </Page>
    );
  }

  const screen = sequenceScreen(state);
  // A refused save-and-approve names every rule the text failed; the sentence is the
  // notice, and it belongs under the form that is still open.
  const serverIssues = screen.notice !== null && screen.notice.startsWith('Not approved.') ? [screen.notice] : [];

  return (
    <Page data-testid="sequences" aria-busy={sequences.pending > 0}>
      <ViewHeader title="Sequences" />
      <div data-testid="banners" className="mt-3 flex flex-col gap-2 empty:hidden">
        {screen.banner === null ? null : (
          <Alert tone="warning" data-testid="sequence-banner">
            {screen.banner}
          </Alert>
        )}
        {screen.notice === null || serverIssues.length > 0 ? null : (
          <Alert tone="info" data-testid="sequence-notice">
            {screen.notice}
          </Alert>
        )}
        {screen.warnings.map(warning => (
          <Alert key={warning} tone="warning" data-testid="template-warning">
            {warning}
          </Alert>
        ))}
      </div>

      <UnreadSlice screen={screen} slice="sequences" onRetry={sequences.actions.refresh} />
      <Section
        title="Sequences"
        count={screen.sequences.length}
        actions={
          <form
            className="flex items-center gap-1"
            data-testid="new-sequence"
            onSubmit={event => {
              event.preventDefault();
              if (name.trim() === '') {
                setNameMissing(true);
                return;
              }
              setNameMissing(false);
              sequences.actions.createSequence(name.trim());
              setName('');
            }}
          >
            <Input
              data-testid="new-sequence-name"
              aria-label="Name a new sequence"
              placeholder="Name a new sequence"
              autoComplete="off"
              maxLength={200}
              disabled={!screen.canAuthor}
              {...(nameMissing ? { 'aria-invalid': true } : {})}
              value={name}
              onChange={event => {
                setName(event.target.value);
              }}
              className="h-7 w-52 text-xs"
            />
            <Button
              type="submit"
              size="sm"
              data-testid="new-sequence-create"
              disabled={!screen.canAuthor || sequences.busy('new-sequence')}
            >
              New sequence
            </Button>
          </form>
        }
      >
        {screen.sequences.length === 0 ? (
          <p data-testid="sequence-empty" className="py-2 text-sm text-muted-foreground">
            No sequences yet. Name your first one above.
          </p>
        ) : (
          <Rows data-testid="sequence-list">
            {screen.sequences.map(entry => (
              <Row key={entry.id} data-testid="sequence" {...(entry.selected ? { 'data-selected': 'true' } : {})}>
                <RowMain
                  line={
                    <Button
                      variant="link"
                      size="sm"
                      data-testid="sequence-open"
                      className="h-auto px-0 text-sm"
                      onClick={() => {
                        sequences.actions.openSequence(entry.id);
                      }}
                    >
                      <span data-testid="sequence-name">{entry.name}</span>
                    </Button>
                  }
                />
                {entry.selected ? <Tag tone="none">open</Tag> : null}
              </Row>
            ))}
          </Rows>
        )}
      </Section>

      <UnreadSlice screen={screen} slice="versions" onRetry={sequences.actions.refresh} />
      {screen.versions.map(panel => {
        const version = state.versions.find(entry => entry.id === panel.id);
        return (
          <Section
            key={panel.id}
            data-testid="version"
            title={panel.heading}
            count={panel.steps.length}
            actions={
              <>
                {panel.state === 'draft' ? (
                  <Button
                    size="sm"
                    data-testid="version-publish"
                    disabled={!panel.canPublish || sequences.busy(`version:${panel.id}`)}
                    onClick={() => {
                      sequences.actions.publish(panel.id);
                    }}
                  >
                    Publish
                  </Button>
                ) : null}
                {panel.state === 'published' ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    data-testid="version-retire"
                    disabled={!panel.canRetire || sequences.busy(`version:${panel.id}`)}
                    onClick={() => {
                      sequences.actions.retire(panel.id);
                    }}
                  >
                    Retire
                  </Button>
                ) : null}
              </>
            }
          >
            <span data-testid="version-heading" className="sr-only">
              {panel.heading}
            </span>
            <p data-testid="version-stops" className="text-xs text-muted-foreground">
              {panel.stopSentence}
            </p>
            <details data-testid="version-details" className="text-xs text-muted-foreground">
              <summary className="cursor-default">Details</summary>
              <p>{`Stop conditions: ${panel.stopConditions.join(', ')}`}</p>
            </details>

            {panel.editable && version !== undefined ? (
              <StepEditor
                panel={panel}
                version={version}
                state={state}
                saving={sequences.busy(`steps:${panel.id}`)}
                onSave={steps => {
                  sequences.actions.saveSteps({ sequenceVersionId: panel.id, steps });
                }}
              />
            ) : (
              <Rows data-testid="version-steps" className="mt-2">
                {panel.steps.map(step => (
                  <Row key={step.ordinal} data-testid="step">
                    <span data-testid="step-channel" className="sr-only">
                      {step.channel}
                    </span>
                    <RowMain
                      line={<span data-testid="step-detail">{step.detail}</span>}
                      detail={
                        <>
                          <span data-testid="step-delay">{step.delayLabel}</span>
                          {step.problem === null ? null : (
                            <span data-testid="step-problem" className="block text-destructive">
                              {step.problem}
                            </span>
                          )}
                        </>
                      }
                    />
                  </Row>
                ))}
              </Rows>
            )}

            {panel.publishRefusal === null || panel.state !== 'draft' ? null : (
              <p data-testid="publish-refusal" className="mt-2 text-xs text-muted-foreground">
                {PUBLISH_REFUSAL_SENTENCES[panel.publishRefusal] ?? panel.publishRefusal}
              </p>
            )}
          </Section>
        );
      })}

      <UnreadSlice screen={screen} slice="enrollments" onRetry={sequences.actions.refresh} />
      {screen.enrollments === null ? null : (
        <Section title="Enrolled" count={screen.enrollments.rows.length} data-testid="enrollments">
          <p data-testid="enrollment-summary" className="py-1 text-sm text-muted-foreground">
            {screen.enrollments.summary}
          </p>
          <Rows>
            {screen.enrollments.rows.map(row => (
              <Row key={row.sequenceVersionId} data-testid="enrollment">
                <RowMain line={<span data-testid="enrollment-line">{row.line}</span>} />
              </Row>
            ))}
          </Rows>
        </Section>
      )}

      <UnreadSlice screen={screen} slice="templates" onRetry={sequences.actions.refresh} />
      <TemplatePanels
        screen={screen}
        state={state}
        editingId={formOpen ? (editing?.templateVersionId ?? 'new') : null}
        onEdit={template => {
          setEditing({
            templateVersionId: template.id,
            name: template.name,
            subject: template.subject,
            body: typedBodyOf(template),
            signOff: template.footerSignOff,
            note: screen.templates.find(panel => panel.id === template.id)?.editNote ?? null,
          });
          setFormOpen(true);
        }}
        onNew={() => {
          setEditing(null);
          setFormOpen(true);
        }}
      />
      {formOpen ? (
        <TemplateForm
          editing={editing}
          enabled={screen.canAuthor && !sequences.busy('template-form')}
          issues={serverIssues}
          onSave={draft => {
            sequences.actions.saveTemplate(draft);
            setFormOpen(false);
            setEditing(null);
          }}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      ) : null}
    </Page>
  );
}
