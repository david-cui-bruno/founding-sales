import { expect, test } from 'playwright/test';
import {
  populatedSequenceState,
  startSequencesTestServer,
  unreadSequenceState,
  type SequencesTestServer,
} from './support/sequencesTestServer.ts';

/**
 * The sequence editor window, driven end to end against the generated test server
 * (lane g78).
 *
 * The renderer is the shipped file; only the bridge is substituted. Two things a person
 * sees changed in g78: a populated version draws its steps, because the parser behind
 * it now reads what the API sends (D01, D02); and a read that failed says so, with
 * Retry, instead of drawing an empty list that reads as "there are none" (D06).
 */

let server: SequencesTestServer;

test.afterEach(async () => {
  await server.stop();
});

test('a populated version draws both its steps, the template and the held enrollment', async ({ page }) => {
  server = await startSequencesTestServer([populatedSequenceState()]);
  await page.goto(server.url);

  await expect(page.getByTestId('version-heading')).toHaveText('Version 1 — published');
  await expect(page.getByTestId('step')).toHaveCount(2);
  await expect(page.getByTestId('step-detail')).toHaveText(['Template email', 'LinkedIn task, opened and copied by hand']);
  await expect(page.getByTestId('template-label')).toHaveText('First touch v1');
  await expect(page.getByTestId('hold-row')).toHaveCount(1);
  await expect(page.getByTestId('hold-explanation')).toContainText('about 9 days');
  await expect(page.getByTestId('sequence-unread-line')).toHaveCount(0);
});

test('a read that failed is one grey line with Retry, not an empty list, and Retry reads again', async ({ page }) => {
  server = await startSequencesTestServer([unreadSequenceState(), populatedSequenceState()]);
  await page.goto(server.url);

  // The list that did read is drawn; the three that did not each say why.
  await expect(page.getByTestId('sequence-name')).toHaveText('Founding outreach');
  await expect(page.getByTestId('sequence-unread-versions')).toContainText(
    'Callie could not read this sequence’s versions. The answer was not in the shape this version of Callie reads (unreadable_answer).',
  );
  await expect(page.getByTestId('sequence-unread-templates')).toContainText(
    'Callie could not read the templates. The server answered service_unavailable.',
  );
  await expect(page.getByTestId('sequence-unread-enrollments')).toContainText(
    'Callie could not read the enrollments. The server did not answer (offline).',
  );
  await expect(page.getByTestId('sequence-unread-sequences')).toHaveCount(0);
  await expect(page.getByTestId('version')).toHaveCount(0);

  await page.getByTestId('sequence-retry-versions').click();
  await expect(page.getByTestId('sequence-unread-line')).toHaveCount(0);
  await expect(page.getByTestId('step')).toHaveCount(2);
  expect(server.calls.filter(call => call.method === 'state')).toHaveLength(2);
});
