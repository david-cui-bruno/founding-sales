import { expect, test, type Page } from 'playwright/test';
import {
  MESSAGE_ID,
  OTHER_MESSAGE_ID,
  replyCard,
  replyState,
} from './support/replyFixtures.ts';
import { startAppServer, type AppServer, type BridgeHandle } from './support/appServer.ts';
import type { ReplyState } from '../../src/renderer/replyContract.ts';

/**
 * The Replies view, driven end to end against the one test harness
 * (specification 8.3, 12.4).
 *
 * The renderer is the shipped file; only the bridge is substituted, so what these
 * specs prove is what a person actually sees and can press. Four of them are the
 * authority boundary as a person experiences it: the suggestion is visible and
 * nothing is selected, Confirm is dead until they choose, a body they may not read is
 * not on the page at all, and a reply that looks lost says so without offering to
 * close anything.
 */

let app: AppServer;
let server: BridgeHandle<ReplyState>;

test.afterEach(async () => {
  await app.stop();
});

async function openReplies(page: Page, state: ReplyState): Promise<void> {
  app = await startAppServer({ replies: state });
  server = app.replies;
  await page.goto(app.url('#replies'));
}

test('lists the day’s replies and says which model is suggesting', async ({ page }) => {
  await openReplies(
    page,
    replyState({
      cards: [
        replyCard(),
        replyCard({ messageId: OTHER_MESSAGE_ID, proposedDisposition: null, proposedBy: 'none', confidence: null }),
      ],
    }),
  );

  await expect(page.getByTestId('heading')).toHaveText('Replies');
  await expect(page.getByTestId('business-date')).toHaveText('2026-09-21');
  await expect(page.getByTestId('reply-summary')).toHaveCount(2);
  await expect(page.getByTestId('summary-line').nth(0)).toContainText('Callie suggests: Interested');
  await expect(page.getByTestId('summary-line').nth(1)).toContainText('Needs an answer');
  await expect(page.getByTestId('classifier-line')).toHaveText(
    'Suggestions come from claude-opus-5 at low effort.',
  );
});

test('a message body that looks like markup is shown as text', async ({ page }) => {
  await openReplies(
    page,
    replyState({ cards: [replyCard({ body: { text: '<img src=x onerror=alert(1)>', truncated: false } })] }),
  );
  await page.getByTestId('reply-open').nth(0).click();

  await expect(page.getByTestId('card-body')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('img')).toHaveCount(0);
});

test('shows the suggestion, selects nothing, and keeps Confirm dead until a person chooses', async ({ page }) => {
  await openReplies(page, replyState());
  await page.getByTestId('reply-open').nth(0).click();

  await expect(page.getByTestId('suggestion-disposition')).toHaveText('Interested');
  await expect(page.getByTestId('suggestion-confidence')).toHaveText('Confident (0.88)');
  await expect(page.getByTestId('suggestion-excerpt')).toHaveText('Tuesday works.');
  await expect(page.getByTestId('suggestion-by')).toHaveText('claude-opus-5, prompt g7b.replies.1');
  // The hint is beside the choice; the radio is not checked. 12.4's boundary, as a
  // person meets it: the model's answer is on screen and is not the form's state.
  await expect(page.getByTestId('suggested-hint')).toHaveCount(1);
  await expect(page.getByTestId('choice-interested')).not.toBeChecked();
  await expect(page.getByTestId('confirm')).toBeDisabled();
  await expect(page.getByTestId('confirm')).toHaveText('Choose what this reply means');

  await page.getByTestId('choice-interested').check();
  await expect(page.getByTestId('confirm')).toBeEnabled();
  await expect(page.getByTestId('confirm')).toHaveText('Confirm: Interested');
  await expect(page.getByTestId('consequence')).toContainText('stops automated sending');

  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('banner-info')).toHaveText('Recorded.');
  expect(server.calls.filter(call => call.method === 'confirm')).toHaveLength(1);
  expect(server.calls.find(call => call.method === 'confirm')?.argument).toEqual({
    messageId: MESSAGE_ID,
    disposition: 'interested',
    callback: null,
    firmWideOptOut: false,
    note: '',
  });
});

test('asks for the callback the model only proposed, prefilled and still the person’s', async ({ page }) => {
  await openReplies(
    page,
    replyState({ cards: [replyCard({ callbackProposal: { localDateTime: '2026-09-28T09:00', timeZone: null } })] }),
  );
  await page.getByTestId('reply-open').nth(0).click();

  // Hidden until the disposition that has a callback is chosen.
  await expect(page.getByTestId('callback')).toBeHidden();
  await page.getByTestId('choice-follow_up_later').check();
  await expect(page.getByTestId('callback')).toBeVisible();
  await expect(page.getByTestId('callback-date')).toHaveValue('2026-09-28');
  await expect(page.getByTestId('callback-time')).toHaveValue('09:00');

  await page.getByTestId('callback-date').fill('2026-09-29');
  await page.getByTestId('confirm').click();
  expect(server.calls.find(call => call.method === 'confirm')?.argument).toEqual({
    messageId: MESSAGE_ID,
    disposition: 'follow_up_later',
    callback: { localDate: '2026-09-29', localTime: '09:00', sourceTimeZone: 'America/New_York' },
    firmWideOptOut: false,
    note: '',
  });
});

test('offers the firm-wide do-not-contact only on an opt-out, and never ticks it', async ({ page }) => {
  await openReplies(page, replyState());
  await page.getByTestId('reply-open').nth(0).click();

  await expect(page.getByTestId('firm-wide-label')).toBeHidden();
  await page.getByTestId('choice-opt_out').check();
  await expect(page.getByTestId('firm-wide-label')).toBeVisible();
  // 9.1's question, answered by the person. Nothing infers it from the wording.
  await expect(page.getByTestId('firm-wide')).not.toBeChecked();

  await page.getByTestId('confirm').click();
  expect((server.calls.find(call => call.method === 'confirm')?.argument as { firmWideOptOut: boolean }).firmWideOptOut).toBe(
    false,
  );
});

test('says a reply looks lost and offers nothing that would close it', async ({ page }) => {
  await openReplies(page, replyState());
  await page.getByTestId('reply-open').nth(0).click();
  await page.getByTestId('choice-not_interested').check();
  await expect(page.getByTestId('consequence')).toContainText('does not close anything');

  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('banner-info')).toContainText('mark the deal Lost on the firm page');
  // There is no control anywhere on this page that would do it.
  await expect(page.getByRole('button', { name: /lost|close the deal/iu })).toHaveCount(0);
});

test('shows a member who may not read the body the impact and no answer', async ({ page }) => {
  await openReplies(
    page,
    replyState({
      cards: [
        replyCard({
          body: null,
          subject: null,
          contactName: null,
          supportingExcerpt: null,
          visibility: 'any_active_member',
        }),
      ],
    }),
  );
  await page.getByTestId('reply-open').nth(0).click();

  await expect(page.getByTestId('card-body')).toHaveCount(0);
  await expect(page.getByTestId('card-redacted')).toBeVisible();
  await expect(page.getByTestId('suggestion-excerpt')).toHaveText('—');
  await expect(page.getByTestId('impact-line').first()).toContainText('Automated sending is on');
  await expect(page.getByTestId('disposition-form')).toHaveCount(0);
});

test('offers no disposition for an unresolved ambiguity, and names the candidates', async ({ page }) => {
  await openReplies(
    page,
    replyState({
      cards: [
        replyCard({
          nextAction: 'resolve_ambiguity',
          impact: {
            controlMode: 'automated',
            holds: [],
            ambiguous: true,
            candidates: [
              { opportunityId: '55555555-5555-4555-8555-555555555555', firmId: '33333333-3333-4333-8333-333333333333', firmName: 'Northwind Test Holdings', selected: null },
              { opportunityId: '66666666-6666-4666-8666-666666666666', firmId: '44444444-4444-4444-8444-444444444444', firmName: 'Larkspur Test Foundry', selected: null },
            ],
            contactsAtFirm: 1,
          },
        }),
      ],
    }),
  );
  await page.getByTestId('reply-open').nth(0).click();

  await expect(page.getByTestId('disposition-form')).toHaveCount(0);
  await expect(page.getByTestId('card-banner-blocking')).toHaveText(
    'Pick which conversation this reply belongs to first.',
  );
  await expect(page.getByTestId('ambiguity-candidate')).toHaveCount(2);

  // Lane g88 (audit G07): the candidates are a choice, not paragraphs. Nothing is chosen
  // until the person chooses, and "This one" sends G7's resolution for the one chosen.
  await expect(page.getByTestId('candidate-submit')).toBeDisabled();
  await page.getByTestId('candidate-choice').nth(1).check();
  await page.getByTestId('candidate-submit').click();
  await expect(page.getByTestId('banner-info')).toHaveText('Linked to that conversation. Now say what the reply means.');
  expect(server.calls.find(entry => entry.method === 'resolve')?.argument).toEqual({
    messageId: expect.any(String),
    opportunityId: '66666666-6666-4666-8666-666666666666',
  });
  // Resolved, the card asks the next question.
  await expect(page.getByTestId('disposition-form')).toBeVisible();
  await expect(page.getByTestId('candidate-form')).toHaveCount(0);
});

test('is readable and unpressable when Callie cannot reach the server', async ({ page }) => {
  // Nothing on this window is cached — a reply card is somebody's mail — so an
  // outage is an empty lane and a notice rather than a stale card to answer.
  await openReplies(page, replyState({ online: false, cards: [] }));

  await expect(page.getByTestId('banner-warning')).toHaveText('Callie cannot reach the server.');
  await expect(page.getByTestId('reply-empty')).toHaveText(
    'Callie cannot reach the server, and replies are never kept on this Mac.',
  );
  await expect(page.getByTestId('reply-summary')).toHaveCount(0);
});
