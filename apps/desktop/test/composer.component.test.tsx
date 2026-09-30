// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { TemplateForm } from '../src/renderer/sequences/TemplateForm.tsx';
import { composeTemplateBody, templateFooter, typedBodyOf } from '../src/renderer/sequenceView.ts';

/**
 * What the composer says an automated email will end with (David, 29 September 2026).
 *
 * The decision recorded in `docs/greenfield/decisions/email-presentation-20260929.md`
 * removed the mandatory last line: an email ends with the sign-off, the workspace's
 * postal address is composed at send when there is one, and a visible opt-out link is
 * still refused because Callie takes a stop request in ordinary language.
 *
 * PR 311 made the contracts and the server agree with that. This file holds the
 * *window* to it, which is the half a person actually reads: a preview that still
 * showed the old last line would tell David his emails carry a sentence they do not,
 * and he would write around a rule that no longer exists.
 */

const signOff = 'David\nCallie';

const form = (editing: Parameters<typeof TemplateForm>[0]['editing'] = null): void => {
  render(
    <DraftsProvider>
      <TemplateForm editing={editing} enabled issues={[]} onSave={async () => await Promise.resolve(true)} onCancel={() => undefined} />
    </DraftsProvider>,
  );
};

afterEach(cleanup);

describe('the template composer', () => {
  it('previews the sign-off alone, with no stop line and no opt-out anywhere', () => {
    form({
      templateVersionId: '55555555-5555-4555-8555-555555555555',
      name: 'First touch',
      subject: 'A question about your work orders',
      // What the route hands the form: the typed part of the stored body.
      body: typedBodyOf({ body: composeTemplateBody('Hello,\n\nA short note.', signOff), footerSignOff: signOff }),
      signOff,
    });

    expect(screen.getByTestId('template-footer-preview').textContent).toBe(signOff);
    // The old last line is nowhere: not in the preview, not in the hints, not as a
    // sentence about a rule that no longer applies.
    const shown = (document.body.textContent ?? '').toLowerCase();
    expect(document.body.textContent).not.toContain(SENDING_STOP_LINE);
    expect(shown).not.toContain('unsubscribe');
    expect(shown).not.toContain('opt out');
    expect(shown).not.toContain('opt-out');
    // And what the person edits is what they typed, not the footer under it.
    expect((screen.getByTestId('template-form-body') as HTMLTextAreaElement).value).toBe('Hello,\n\nA short note.');
  });

  it('hands back the typed words of a template approved before the decision', () => {
    // A body stored with the pre-0024 ending. The form must not show the old last
    // line back to somebody as though it were theirs to keep or delete.
    const stored = `Hello,\n\nA short note.\n\n${signOff}\n${SENDING_STOP_LINE}`;
    form({
      templateVersionId: '66666666-6666-4666-8666-666666666666',
      name: 'An older one',
      subject: 'Still here',
      body: typedBodyOf({ body: stored, footerSignOff: signOff }),
      signOff,
    });

    expect((screen.getByTestId('template-form-body') as HTMLTextAreaElement).value).toBe('Hello,\n\nA short note.');
    expect(document.body.textContent).not.toContain(SENDING_STOP_LINE);
  });

  it('composes the sign-off and nothing else under the body', () => {
    expect(templateFooter(signOff)).toBe(signOff);
    expect(composeTemplateBody('A note.', signOff)).toBe(`A note.\n\n${signOff}`);
  });
});
