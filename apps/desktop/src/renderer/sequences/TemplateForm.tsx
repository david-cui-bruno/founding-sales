import type { JSX } from 'react';
import { SENDING_STOP_LINE, TEMPLATE_VARIABLE_NAMES } from '@fss/contracts';
import { useClearDrafts, useDrafts } from '../app/drafts.tsx';
import type { TemplateDraft } from '../sequenceContract.ts';
import { templateFormIssues, templateFormWarnings } from '../sequenceView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Field } from '../ui/layout.tsx';
import { Textarea } from '../ui/textarea.tsx';

/**
 * The template form (lane g88; wave 2, S3).
 *
 * A name, a subject, the email and the sign-off. The stop line is not typed: every email
 * ends with the sign-off and then it, and the form shows that ending under the body.
 *
 * **One press saves and approves** (D5). `/templates/create` and `/templates/update` take
 * `approve: true` and refuse the whole command, with every issue, when the text does not
 * pass — so a version is never written that cannot be approved, and there is no second
 * button to forget. Editing an approved version edits it in place; the content hash is
 * recomputed and the rules re-run, and it stays approved only if they pass.
 *
 * What is typed lives in the shell's draft store, so leaving Sequences and coming back
 * does not lose the email somebody was writing.
 */

const DRAFTS = 'template:';

export function TemplateForm({
  /** The version being edited in place, or null for a new template. */
  editing,
  enabled,
  issues,
  onSave,
  onCancel,
}: {
  readonly editing: { readonly templateVersionId: string; readonly name: string; readonly subject: string; readonly body: string; readonly signOff: string } | null;
  readonly enabled: boolean;
  /** The issues the server named on the last save, by field. */
  readonly issues: readonly string[];
  onSave(draft: TemplateDraft): void;
  onCancel(): void;
}): JSX.Element {
  const clear = useClearDrafts();
  const { values, set } = useDrafts();
  const valueOf = (key: 'name' | 'subject' | 'body' | 'signOff'): string => values[`${DRAFTS}${key}`] ?? editing?.[key] ?? '';
  const draft: TemplateDraft = {
    templateVersionId: editing?.templateVersionId ?? null,
    name: valueOf('name'),
    subject: valueOf('subject'),
    body: valueOf('body'),
    signOff: valueOf('signOff'),
  };
  const found = templateFormIssues(draft);
  const warnings = templateFormWarnings(draft);
  const issueFor = (field: 'name' | 'subject' | 'body' | 'signOff'): readonly { readonly testId: string; readonly text: string }[] =>
    found.filter(issue => issue.field === field).map(issue => ({ testId: `template-issue-${field}`, text: issue.text }));

  return (
    <form
      data-testid="template-form"
      noValidate
      className="mt-4 flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault();
        if (found.length > 0) return;
        clear(DRAFTS);
        onSave(draft);
      }}
    >
      <h3 className="text-sm font-medium">{editing === null ? 'New template' : 'Edit this template'}</h3>
      <Field label="Name" htmlFor="template-form-name" issues={issueFor('name')}>
        <Input
          id="template-form-name"
          data-testid="template-form-name"
          type="text"
          autoComplete="off"
          disabled={!enabled}
          value={draft.name}
          onChange={event => {
            set(`${DRAFTS}name`, event.target.value);
          }}
        />
      </Field>
      <Field label="Subject" htmlFor="template-form-subject" issues={issueFor('subject')}>
        <Input
          id="template-form-subject"
          data-testid="template-form-subject"
          type="text"
          autoComplete="off"
          disabled={!enabled}
          value={draft.subject}
          onChange={event => {
            set(`${DRAFTS}subject`, event.target.value);
          }}
        />
      </Field>
      <Field
        label="Email"
        htmlFor="template-form-body"
        hint={`You can use ${TEMPLATE_VARIABLE_NAMES.map(name => `{${name}}`).join(', ')}. Plain text; one link and 89 words with the sign-off are suggestions, not rules.`}
        issues={issueFor('body')}
      >
        <Textarea
          id="template-form-body"
          data-testid="template-form-body"
          rows={10}
          disabled={!enabled}
          value={draft.body}
          onChange={event => {
            set(`${DRAFTS}body`, event.target.value);
          }}
        />
      </Field>
      <Field label="Sign-off" htmlFor="template-form-signOff" hint="Your name, and anything that goes under it." issues={issueFor('signOff')}>
        <Textarea
          id="template-form-signOff"
          data-testid="template-form-signOff"
          rows={3}
          disabled={!enabled}
          value={draft.signOff}
          onChange={event => {
            set(`${DRAFTS}signOff`, event.target.value);
          }}
        />
      </Field>

      <p className="text-xs text-muted-foreground">Every email ends with your sign-off and then:</p>
      <blockquote data-testid="template-stop-line" className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
        {SENDING_STOP_LINE}
      </blockquote>

      <div data-testid="template-advice" className="flex flex-col gap-0.5 empty:hidden">
        {warnings.map(text => (
          <p key={text} data-testid="template-form-warning" className="text-xs text-muted-foreground">
            {text}
          </p>
        ))}
      </div>
      <div data-testid="template-issues" className="flex flex-col gap-0.5 empty:hidden">
        {issues.map(text => (
          <p key={text} className="text-xs text-destructive">
            {text}
          </p>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <Button type="submit" size="sm" data-testid="template-save" disabled={!enabled || found.length > 0}>
          Save and approve
        </Button>
        <Button
          size="sm"
          variant="quiet"
          data-testid="template-cancel"
          onClick={() => {
            clear(DRAFTS);
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
