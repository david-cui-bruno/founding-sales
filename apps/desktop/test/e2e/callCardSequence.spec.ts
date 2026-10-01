import { expect, test } from 'playwright/test';
import {
  AGREED_SEQUENCE_VERSION_ID,
  FIRM_ID,
  expandedFirm,
  todayState,
} from './support/homeFixtures.ts';
import { startAppServer, type AppServer } from './support/appServer.ts';

/**
 * The call card's agreed sequence, in the shipped renderer (send-path v2, slice S3).
 *
 * David, 30 September 2026: *"Include no email / one approved email / an agreed approved
 * sequence ... Show the messages and timing and record the prospect's agreement.
 * Starting an agreed sequence should not require an API command."* So on an interested
 * call a person picks "An agreed sequence", picks the sequence, reads its messages and
 * dates on the firm's clock, records the call — and the notice names the sequence and
 * says it started. Only the bridges are substituted.
 *
 * No real person or business appears; `example.test` is reserved by RFC 6761.
 */

let server: AppServer;

test.afterEach(async () => {
  await server.stop();
});

test('an interested call agrees to a sequence, shows its plan, and starts it', async ({ page }) => {
  server = await startAppServer({
    today: todayState({
      expanded: expandedFirm(),
      followUpTemplates: [{ id: '66666666-6666-4666-8666-666666666666', name: 'The overview' }],
      followUpSequences: [{ sequenceVersionId: AGREED_SEQUENCE_VERSION_ID, name: 'After a good call v3' }],
    }),
  });
  await page.goto(server.url());
  await expect.poll(() => server.called('today.refresh').length).toBeGreaterThan(0);
  await expect(page.getByTestId('today')).toHaveAttribute('aria-busy', 'false');
  // Slice S2: the expanded firm opens in the middle by itself; its outcome form is one press away.
  await page.getByTestId('firm-outcome').click();

  await page.getByTestId('outcome-select').selectOption('interested');
  await expect(page.getByTestId('outcome-follow-up-kind').locator('option')).toHaveText([
    'No follow-up',
    'One approved e-mail',
    'An agreed sequence',
  ]);
  await page.getByTestId('outcome-follow-up-kind').selectOption('agreed_sequence');
  await expect(page.getByTestId('outcome-submit')).toBeDisabled();
  await page.getByTestId('outcome-follow-up-sequence').selectOption(AGREED_SEQUENCE_VERSION_ID);

  // The plan, before anything is recorded: each message and its date on Chicago's clock.
  await expect(page.getByTestId('preview-step-what')).toHaveText([
    '1. E-mail — The overview: “The overview for {firm_name}”',
    '2. A call',
  ]);
  await expect(page.getByTestId('preview-step-when')).toHaveText(['Wed 23 Sep, 08:00 CDT', 'Fri 25 Sep, 09:00 CDT']);
  expect(server.called('today.previewFollowUp')).toEqual([
    { firmId: FIRM_ID, contactId: '88888888-8888-4888-8888-888888888888', sequenceVersionId: AGREED_SEQUENCE_VERSION_ID },
  ]);

  await expect(page.getByTestId('outcome-submit')).toBeEnabled();
  await page.getByTestId('outcome-submit').click();
  const [recorded] = server.called('today.recordOutcome') as Record<string, unknown>[];
  expect(recorded).toMatchObject({
    firmId: FIRM_ID,
    outcome: 'interested',
    contactId: '88888888-8888-4888-8888-888888888888',
    followUpPermission: {
      scope: 'agreed_sequence',
      sequenceVersionId: AGREED_SEQUENCE_VERSION_ID,
      previewBasis: { anchorAt: '2026-09-21T14:00:00.000Z', timeZone: 'America/Chicago', calendarVersionId: 'none.1' },
    },
  });
  await expect(page.getByTestId('banner-info').filter({ hasText: 'agreed sequence started' })).toBeVisible();
  await expect(
    page.getByTestId('banner-info').filter({ hasText: 'Agreed on the call: the sequence “After a good call v3”. It has started.' }),
  ).toBeVisible();
});
