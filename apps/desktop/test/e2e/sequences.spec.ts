import { expect, test, type Page } from 'playwright/test';
import { SEQUENCE_IDS } from '../support/sequenceAnswers.ts';
import {
  emptyDraftState,
  populatedSequenceState,
  unreadSequenceState,
} from './support/sequenceFixtures.ts';
import { startAppServer, type AppServer, type BridgeHandle } from './support/appServer.ts';
import type { SequenceState } from '../../src/renderer/sequenceContract.ts';

/**
 * The Sequences view, driven end to end against the one test harness
 * (lane g78).
 *
 * The renderer is the shipped file; only the bridge is substituted. Two things a person
 * sees changed in g78: a populated version draws its steps, because the parser behind
 * it now reads what the API sends (D01, D02); and a read that failed says so, with
 * Retry, instead of drawing an empty list that reads as "there are none" (D06).
 */

let app: AppServer;
let server: BridgeHandle<SequenceState>;

test.afterEach(async () => {
  await app.stop();
});

/** The Sequences view, whose `state()` answers `answers` one per call and whose methods `scripted` moves. */
async function openSequences(
  page: Page,
  answers: readonly SequenceState[],
  scripted: Readonly<Partial<Record<string, SequenceState>>> = {},
): Promise<void> {
  app = await startAppServer({ sequences: answers, sequencesScripted: scripted });
  server = app.sequences;
  await page.goto(app.url('#sequences'));
}

test('a populated version draws its steps, its template and who is enrolled', async ({ page }) => {
  await openSequences(page, [populatedSequenceState()]);

  await expect(page.getByTestId('version-heading')).toHaveText('Version 1 — published');
  await expect(page.getByTestId('step')).toHaveCount(2);
  // The version is published, so it is edited in place (wave 2, S3): the rows are the
  // editor's, and the channel of each is the control rather than a sentence.
  await expect(page.getByTestId('step-channel-select').first()).toHaveValue('email');
  await expect(page.getByTestId('step-channel-select').nth(1)).toHaveValue('call_task');
  await expect(page.getByTestId('template-label')).toHaveText('First touch v1');
  await expect(page.getByTestId('enrollment-summary')).toHaveText('One person is working through this sequence.');
  await expect(page.getByTestId('enrollment-line')).toHaveText('Version 1 — 1 running');
  await expect(page.getByTestId('sequence-unread-line')).toHaveCount(0);

  // 1.0.13: the last hand-rolled page is gone, and with it `legacy.css`, the layer it
  // needed and the attribute that scoped it.
  await expect(page.getByTestId('legacy-view')).toHaveCount(0);
  await expect(page.locator('[data-legacy]')).toHaveCount(0);
});

test('a read that failed is one grey line with Retry, not an empty list, and Retry reads again', async ({ page }) => {
  await openSequences(page, [unreadSequenceState(), populatedSequenceState()]);

  // The list that did read is drawn; the three that did not each say why.
  await expect(page.getByTestId('sequence-name')).toHaveText('Founding outreach');
  await expect(page.getByTestId('sequence-unread-versions')).toContainText(
    'Callie could not read this sequence’s versions. The answer was not in the shape this version of Callie reads (unreadable_answer).',
  );
  await expect(page.getByTestId('sequence-unread-templates')).toContainText(
    'Callie could not read the templates. The server answered service_unavailable.',
  );
  await expect(page.getByTestId('sequence-unread-enrollments')).toHaveCount(0);
  await expect(page.getByTestId('sequence-unread-sequences')).toHaveCount(0);
  await expect(page.getByTestId('version')).toHaveCount(0);

  await page.getByTestId('sequence-retry-versions').click();
  await expect(page.getByTestId('sequence-unread-line')).toHaveCount(0);
  await expect(page.getByTestId('step')).toHaveCount(2);
  expect(server.calls.filter(call => call.method === 'state')).toHaveLength(2);
});

// --------------------------------------------------------------- lane g88: authoring
test('a founder fills the suggested plan, changes a delay, saves numbered steps, and Publish waits for the save', async ({ page }) => {
  await openSequences(page, [emptyDraftState()]);

  await expect(page.getByTestId('step')).toHaveCount(0);
  await expect(page.getByTestId('draft-save')).toBeDisabled();
  await page.getByTestId('step-suggested').click();
  await expect(page.getByTestId('step')).toHaveCount(3);
  // Call, email, call — and only those two channels on offer.
  await expect(page.getByTestId('step-channel-select').nth(1)).toHaveValue('email');
  await expect(page.getByTestId('step-channel-select').first().locator('option')).toHaveText(['Call', 'Email']);
  await expect(page.getByTestId('step-template').first()).toHaveValue(SEQUENCE_IDS.template);

  await page.getByTestId('step-delay-amount').nth(2).fill('5');
  await page.getByTestId('step-delay-amount').nth(2).dispatchEvent('change');
  // Publish is the server's own six refusals and nothing else (wave 2): the version
  // being a draft with no saved steps is `version_has_no_steps`, said in words.
  await expect(page.getByTestId('version-publish')).toBeDisabled();
  await expect(page.getByTestId('publish-refusal')).toHaveText('Add at least one step before publishing.');

  await page.getByTestId('draft-save').click();
  const saved = server.calls.find(entry => entry.method === 'saveSteps');
  expect(saved?.argument).toEqual({
    sequenceVersionId: SEQUENCE_IDS.version,
    steps: [
      { channel: 'call_task', delay: { unit: 'business_days', days: 0 }, onNoAnswer: 'advance', templateVersionId: null },
      { channel: 'email', delay: { unit: 'business_days', days: 2 }, onNoAnswer: null, templateVersionId: SEQUENCE_IDS.template },
      { channel: 'call_task', delay: { unit: 'business_days', days: 5 }, onNoAnswer: 'advance', templateVersionId: null },
    ],
  });
});

test('an email step without a template cannot be saved, and says so', async ({ page }) => {
  await openSequences(page, [emptyDraftState()]);
  await page.getByTestId('step-add-email').click();
  await expect(page.getByTestId('draft-issues')).toHaveText('Step 1: choose the template this email sends.');
  await expect(page.getByTestId('draft-save')).toBeDisabled();
  await page.getByTestId('step-template').selectOption(SEQUENCE_IDS.template);
  await expect(page.getByTestId('draft-issues')).toHaveText('');
  await expect(page.getByTestId('draft-save')).toBeEnabled();
});

test('a new sequence is named and created in one press', async ({ page }) => {
  await openSequences(page, [emptyDraftState()]);
  await page.getByTestId('new-sequence-name').fill('Spring outreach');
  await page.getByTestId('new-sequence-create').click();
  await expect.poll(() => server.calls.find(entry => entry.method === 'createSequence')?.argument).toEqual({ name: 'Spring outreach' });
});

/**
 * Writing a template is one press (wave 2, S3; D5): the button says "Save and approve",
 * and `approve: true` goes with the text, so a version is never written that cannot be
 * approved and there is no second control to find.
 */
test('the template form refuses a variable Callie cannot fill, then saves and approves in one press', async ({ page }) => {
  await openSequences(page, [emptyDraftState()]);

  // The digest is there, behind Details, not on the face of the template.
  await expect(page.getByTestId('template-hash')).toBeHidden();
  await expect(page.getByTestId('template-status')).toHaveText('Approved');

  await page.getByTestId('template-new').click();
  await page.getByTestId('template-form-name').fill('Second touch');
  await page.getByTestId('template-form-subject').fill('Following up, {firm_name}');
  await page.getByTestId('template-form-body').fill('Hi {first},\n\nA short follow-up.');
  await page.getByTestId('template-form-signOff').fill('David');
  // The refusal is under the field as it is typed, and the one button is disabled:
  // nothing to press, so nothing to send.
  await expect(page.getByTestId('template-issue-body')).toContainText('Callie cannot fill {first}');
  await expect(page.getByTestId('template-save')).toBeDisabled();
  expect(server.calls.some(entry => entry.method === 'saveTemplate')).toBe(false);

  await page.getByTestId('template-form-body').fill('Hi {contact_first_name},\n\nA short follow-up.');
  await expect(page.getByTestId('template-save')).toHaveText('Save and approve');
  await page.getByTestId('template-save').click();
  await expect.poll(() => server.calls.find(entry => entry.method === 'saveTemplate')?.argument).toEqual({
    templateVersionId: null,
    name: 'Second touch',
    subject: 'Following up, {firm_name}',
    body: 'Hi {contact_first_name},\n\nA short follow-up.',
    signOff: 'David',
  });
});

test('an existing template is edited in place, named by its version rather than superseded', async ({ page }) => {
  await openSequences(page, [emptyDraftState()]);

  await page.getByTestId('template-edit').click();
  await page.getByTestId('template-form-subject').fill('A new subject');
  await page.getByTestId('template-save').click();
  await expect
    .poll(() => (server.calls.find(entry => entry.method === 'saveTemplate')?.argument as { templateVersionId?: string } | undefined)?.templateVersionId)
    .toBe(SEQUENCE_IDS.template);
});

test('a long email is a warning under the form, not a refusal, and the server’s warnings show after the save (wave 1)', async ({ page }) => {
  await openSequences(page, [emptyDraftState()], {
    saveTemplate: emptyDraftState({ notice: 'template_saved', warnings: ['template_body_too_long', 'template_body_multiple_urls'] }),
  });

  await page.getByTestId('template-new').click();
  await page.getByTestId('template-form-name').fill('Long touch');
  await page.getByTestId('template-form-subject').fill('A question, {firm_name}');
  await page.getByTestId('template-form-body').fill('word '.repeat(95));
  await page.getByTestId('template-form-signOff').fill('David');
  await expect(page.getByTestId('template-form-warning')).toContainText('words with its sign-off');
  await page.getByTestId('template-save').click();
  await expect.poll(() => server.calls.filter(entry => entry.method === 'saveTemplate')).toHaveLength(1);

  await expect(page.getByTestId('template-warning')).toHaveText([
    'The email is longer than 89 words, sign-off included.',
    'The email has more than one link.',
  ]);
});

