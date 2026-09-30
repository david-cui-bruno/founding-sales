// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { createGeneration } from '../src/renderer/app/generation.ts';
import type { SequenceState } from '../src/renderer/sequenceContract.ts';
import { SequencesRoute } from '../src/renderer/sequences/SequencesRoute.tsx';
import type { OperationApi, OperationName } from '../src/shared/operations.ts';
import {
  SEQUENCE_IDS,
  callStepAnswer,
  emailStepAnswer,
  sequenceSummaryAnswer,
  sequenceVersionAnswer,
  templateVersionAnswer,
} from './support/sequenceAnswers.ts';

/**
 * The Sequences editor as React components, after send-path v2 (S2): an edit of a
 * published version or an approved template is a new version, and the page says so
 * before the press and names the new version after it.
 *
 *   * a published version's Save reads "Save as new draft", with a line naming the
 *     version everybody enrolled keeps, and it sends the steps against that version —
 *     the server decides where they go;
 *   * after the press the published version's editor shows its own steps again (the
 *     edit is in the new draft's panel), and the notice names the draft's number;
 *   * editing an approved template opens the form with the version the save will make;
 *   * a draft's Save is still "Save", with no line;
 *   * while the sequence has a draft, the published version's Save is off and its line
 *     offers the draft; a `draft_exists` refusal's notice offers it too.
 *
 * No real person, firm or address appears.
 */

const PUBLISHED_ID = SEQUENCE_IDS.version;
const DRAFT_ID = '77777777-7777-4777-8777-777777777777';

const published = sequenceVersionAnswer([emailStepAnswer(SEQUENCE_IDS.template, 1), callStepAnswer(2)], {
  id: PUBLISHED_ID,
  version: 1,
  state: 'published',
  publishedAt: '2026-09-01T12:00:00.000Z',
});

const base = (patch: Partial<SequenceState> = {}): SequenceState => ({
  online: true,
  mayMutate: true,
  isAdmin: true,
  sequences: [sequenceSummaryAnswer()],
  selectedSequenceId: SEQUENCE_IDS.sequence,
  versions: [published],
  templates: [templateVersionAnswer()],
  enrollments: [],
  readErrors: { sequences: null, versions: null, templates: null, enrollments: null },
  notice: null,
  warnings: [],
  ...patch,
});

interface Call {
  readonly operation: OperationName;
  readonly input: unknown;
}

function install(answers: Partial<Record<OperationName, SequenceState>>, initial: SequenceState): Call[] {
  const calls: Call[] = [];
  const answer = async (operation: OperationName, input: unknown): Promise<unknown> => {
    calls.push({ operation, input });
    await Promise.resolve();
    return answers[operation] ?? initial;
  };
  globalThis.callieApi = { read: answer, command: answer } as unknown as OperationApi;
  return calls;
}

function renderRoute(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  render(
    <QueryClientProvider client={client}>
      <DraftsProvider>
        <SequencesRoute identity="person" generation={0} guard={createGeneration().guard} />
      </DraftsProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

describe('the step editor on a published version', () => {
  it('offers Save as new draft, names the version enrolled people keep, and names the new draft after the save', async () => {
    const draft = sequenceVersionAnswer(
      [emailStepAnswer(SEQUENCE_IDS.template, 1), callStepAnswer(2, { delay: { unit: 'business_days', days: 5 } })],
      { id: DRAFT_ID, version: 2, state: 'draft' },
    );
    const afterSave = base({ versions: [draft, published], notice: 'steps_saved_as_version:2' });
    const calls = install({ 'sequences.saveSteps': afterSave }, base());
    renderRoute();

    const panel = await screen.findByTestId('version');
    expect(within(panel).getByTestId('version-heading').textContent).toBe('Version 1 — published');
    expect(within(panel).getByTestId('draft-edit-note').textContent).toBe(
      'Saving makes a new draft version. Everybody already enrolled keeps version 1.',
    );
    const save = within(panel).getByTestId('draft-save');
    expect(save.textContent).toBe('Save as new draft');
    expect((save as HTMLButtonElement).disabled).toBe(true);

    const user = userEvent.setup();
    const amounts = within(panel).getAllByTestId('step-delay-amount');
    await user.clear(amounts[1] as HTMLElement);
    await user.type(amounts[1] as HTMLElement, '5');
    await waitFor(() => {
      expect((within(panel).getByTestId('draft-save') as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(within(panel).getByTestId('draft-save'));

    await waitFor(() => {
      expect(calls.some(call => call.operation === 'sequences.saveSteps')).toBe(true);
    });
    const sent = calls.find(call => call.operation === 'sequences.saveSteps')?.input as { sequenceVersionId: string };
    expect(sent.sequenceVersionId).toBe(PUBLISHED_ID);

    await waitFor(() => {
      expect(screen.getByTestId('sequence-notice').textContent).toBe(
        'Saved as draft version 2. Publish it to use it for new enrollments; everybody already enrolled keeps the version they started on.',
      );
    });
    const panels = screen.getAllByTestId('version');
    expect(panels.map(entry => within(entry).getByTestId('version-heading').textContent)).toEqual([
      'Version 2 — draft',
      'Version 1 — published',
    ]);
    // The draft's Save is plain, with no line; the published editor holds its own steps again.
    const [draftPanel, publishedPanel] = panels as [HTMLElement, HTMLElement];
    expect(within(draftPanel).getByTestId('draft-save').textContent).toBe('Save');
    expect(within(draftPanel).queryByTestId('draft-edit-note')).toBeNull();
    expect((within(publishedPanel).getAllByTestId('step-delay-amount')[1] as HTMLInputElement).value).toBe('2');
  });
});

describe('the template form on an approved version', () => {
  it('says the save makes the next version and leaves the approved one as it is', async () => {
    install({}, base());
    renderRoute();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('template-edit'));
    expect(screen.getByTestId('template-form-note').textContent).toBe(
      'Saving makes version 2. Version 1 stays approved as it is, and so does every sequence that sends it.',
    );
    expect(screen.getByTestId('template-label').textContent).toBe('First touch v1');
  });
});

describe('a published version whose sequence already has a draft', () => {
  const draft = sequenceVersionAnswer([emailStepAnswer(SEQUENCE_IDS.template, 1)], { id: DRAFT_ID, version: 2, state: 'draft' });

  it('turns the published Save off and offers the draft instead', async () => {
    install({}, base({ versions: [draft, published] }));
    renderRoute();
    const panels = await screen.findAllByTestId('version');
    const publishedPanel = panels.find(entry => within(entry).getByTestId('version-heading').textContent === 'Version 1 — published');
    if (publishedPanel === undefined) throw new Error('the published panel is missing');
    expect(within(publishedPanel).getByTestId('draft-edit-note').textContent).toContain(
      'Version 2 is already a draft of this sequence. Make the change there, or publish it first.',
    );
    const user = userEvent.setup();
    const amounts = within(publishedPanel).getAllByTestId('step-delay-amount');
    await user.clear(amounts[1] as HTMLElement);
    await user.type(amounts[1] as HTMLElement, '5');
    expect((within(publishedPanel).getByTestId('draft-save') as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(publishedPanel).getByTestId('draft-open-existing'));
    expect(document.activeElement?.id).toBe(`version-${DRAFT_ID}`);
  });

  it('shows a draft_exists refusal in words and offers the draft it names', async () => {
    install({}, base({ versions: [draft, published], notice: `draft_exists:2:${DRAFT_ID}` }));
    renderRoute();
    const notice = await screen.findByTestId('sequence-notice');
    expect(notice.textContent).toContain(
      'Not saved: version 2 is already a draft of this sequence. Make the change there, or publish it first.',
    );
    const user = userEvent.setup();
    await user.click(within(notice).getByTestId('sequence-notice-open-draft'));
    expect(document.activeElement?.id).toBe(`version-${DRAFT_ID}`);
  });
});

describe('a save that is not accepted keeps what was typed (PR 335 review, P1-4)', () => {
  async function typeIntoPublished(): Promise<HTMLElement> {
    const panel = await screen.findByTestId('version');
    const user = userEvent.setup();
    const amounts = within(panel).getAllByTestId('step-delay-amount');
    await user.clear(amounts[1] as HTMLElement);
    await user.type(amounts[1] as HTMLElement, '5');
    await user.click(within(panel).getByTestId('draft-save'));
    return panel;
  }
  const drafted = sequenceVersionAnswer([emailStepAnswer(SEQUENCE_IDS.template, 1)], { id: DRAFT_ID, version: 2, state: 'draft' });

  it('keeps the published edit when the server refuses it with draft_exists', async () => {
    // Fails if the editor lets go of the edit before the answer (the old order).
    const calls = install(
      { 'sequences.saveSteps': base({ versions: [drafted, published], notice: `draft_exists:2:${DRAFT_ID}` }) },
      base(),
    );
    renderRoute();
    await typeIntoPublished();
    await waitFor(() => {
      expect(screen.getByTestId('sequence-notice').textContent).toContain('Not saved: version 2 is already a draft');
    });
    expect(calls.some(call => call.operation === 'sequences.saveSteps')).toBe(true);
    const publishedPanel = screen
      .getAllByTestId('version')
      .find(entry => within(entry).getByTestId('version-heading').textContent === 'Version 1 — published');
    expect((within(publishedPanel as HTMLElement).getAllByTestId('step-delay-amount')[1] as HTMLInputElement).value).toBe('5');
  });

  it('keeps the published edit when the save could not reach the server', async () => {
    install({ 'sequences.saveSteps': base({ online: false, notice: 'offline' }) }, base());
    renderRoute();
    const panel = await typeIntoPublished();
    await waitFor(() => {
      expect(screen.getByTestId('sequence-notice')).toBeDefined();
    });
    expect((within(panel).getAllByTestId('step-delay-amount')[1] as HTMLInputElement).value).toBe('5');
  });

  async function editTemplateAndSave(): Promise<void> {
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('template-edit'));
    const subject = screen.getByTestId('template-form-subject');
    await user.clear(subject);
    await user.type(subject, 'A better question');
    await user.click(screen.getByTestId('template-save'));
  }

  it('keeps the template form open with the typed text when the save is refused', async () => {
    // Fails if the form clears its draft and closes before the answer.
    const calls = install(
      { 'sequences.saveTemplate': base({ notice: 'template_unapproved:template_footer_missing' }) },
      base(),
    );
    renderRoute();
    await editTemplateAndSave();
    await waitFor(() => {
      expect(calls.some(call => call.operation === 'sequences.saveTemplate')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('template-issues').textContent).toContain('Not approved.');
    });
    expect((screen.getByTestId('template-form-subject') as HTMLInputElement).value).toBe('A better question');
  });

  it('keeps the template form open with the typed text when the save could not reach the server', async () => {
    const calls = install({ 'sequences.saveTemplate': base({ online: false, notice: 'offline' }) }, base());
    renderRoute();
    await editTemplateAndSave();
    await waitFor(() => {
      expect(calls.some(call => call.operation === 'sequences.saveTemplate')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('sequence-banner')).toBeDefined();
    });
    expect((screen.getByTestId('template-form-subject') as HTMLInputElement).value).toBe('A better question');
  });

  it('closes the template form once the save is accepted', async () => {
    install({ 'sequences.saveTemplate': base({ notice: 'template_saved_as_version:2' }) }, base());
    renderRoute();
    await editTemplateAndSave();
    await waitFor(() => {
      expect(screen.queryByTestId('template-form')).toBeNull();
    });
  });
});
