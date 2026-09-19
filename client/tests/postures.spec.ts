import { rm } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import { TERRITORY_CLEARANCE_STATEMENTS, TERRITORY_STATE_RULES } from '../../src/shared/contracts/territoryClearanceContract';
import { startStubWorker, twelveMonthsAfter, type StubWorker } from './stubWorker';
import { launchClient, newUserData, pairThroughUi, type LaunchedClient } from './support/launchClient';

/**
 * The States section of Settings on the real seam (S1b): one row per state in the pool, the reference text beside
 * the form, recording a posture for Rhode Island through `set_state_posture`, seeing it reflected with its review
 * date twelve months out, and adding a state code by hand. Recording a posture confirms no clearance by itself and
 * dials nothing: it is David's decision, kept by the worker (here the stub) with his stamps.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let stub: StubWorker;
let userData: string;
let client: LaunchedClient | undefined;

test.beforeEach(async () => {
  stub = await startStubWorker();
  userData = await newUserData();
  client = await launchClient({ endpoint: stub.url, userData });
  await pairThroughUi(client.page, stub);
  await client.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(client.page.getByRole('heading', { name: 'Settings', exact: true, level: 1 })).toBeVisible();
});

test.afterEach(async () => {
  await client?.close();
  client = undefined;
  await stub.close();
  await rm(userData, { recursive: true, force: true });
});

const stateRow = (page: Page, state: string) => page.locator(`.state[data-state="${state}"]`);

test('shows one row per state in the pool with no posture, the four reference statements, and each state\'s reference text', async () => {
  const { page } = client!;
  // MA and TX come from the Today header's states without posture; RI, MA and TX from the reference texts.
  const rows = page.locator('.state');
  await expect(rows).toHaveCount(3);
  expect(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-state')))).toEqual(['MA', 'RI', 'TX']);
  for (const state of ['MA', 'RI', 'TX']) await expect(stateRow(page, state).getByText('No posture recorded.', { exact: true })).toBeVisible();
  const statements = page.getByRole('list', { name: 'Reference statements', exact: true });
  for (const text of Object.values(TERRITORY_CLEARANCE_STATEMENTS)) await expect(statements.getByText(text, { exact: false })).toBeVisible();
  await expect(page.getByText('Reference statements, revision 2:', { exact: true })).toBeVisible();
  const ri = TERRITORY_STATE_RULES.RI;
  const reference = stateRow(page, 'RI').getByRole('complementary', { name: 'Reference text for RI', exact: true });
  await expect(reference.getByText(ri.summary, { exact: true })).toBeVisible();
  await expect(reference.getByText(ri.citation.title, { exact: true })).toBeVisible();
  await expect(reference.getByText(ri.citation.url, { exact: true })).toBeVisible();
  // Only reads happened on mount: settings and the Today header, no command.
  expect(stub.requests.filter(request => request.method === 'POST' && request.path !== '/v1/pair/redeem')).toEqual([]);
  expect(stub.requests.some(request => request.method === 'GET' && request.path === '/v1/settings')).toBe(true);
});

test('records a posture for RI with a fresh UUID v4 commandId and shows it reflected with the review date twelve months out', async () => {
  const { page } = client!;
  const row = stateRow(page, 'RI');
  await row.getByRole('button', { name: 'Record posture for RI', exact: true }).click();
  const form = row.getByRole('form', { name: 'Posture for RI', exact: true });
  await form.getByLabel('Posture', { exact: true }).selectOption('calling');
  await form.getByLabel('Registration status', { exact: true }).selectOption('exempt');
  await form.getByLabel('Registration citation', { exact: true }).fill('R.I. Gen. Laws § 5-61-2(10): exclusion relied on, checked 18 Sep 2026.');
  await form.getByLabel('Do-not-call list status', { exact: true }).selectOption('not_required');
  await form.getByLabel('Do-not-call citation', { exact: true }).fill('R.I. Gen. Laws § 5-61-3.5: own suppression list under 16 C.F.R. Part 310.');
  await expect(form.getByText('Reference text revision 2 is recorded with the decision.', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Record', exact: true }).click();

  await expect.poll(() => stub.commands.length).toBe(1);
  const command = stub.commands[0]!;
  expect(command.kind).toBe('set_state_posture');
  if (command.kind !== 'set_state_posture') return;
  expect(command.commandId).toMatch(UUID_V4);
  expect(command).toMatchObject({ state: 'RI', posture: 'calling', registration: { status: 'exempt' }, dncList: { status: 'not_required' }, referenceTextRevision: 2 });
  expect(command.counsel).toBeUndefined();
  expect(stub.requests.filter(request => request.path === '/v1/commands').every(request => request.authenticated)).toBe(true);

  // Reflected after the re-read, with the worker's stamps: decided today by this device, review due twelve months out.
  await expect(form.getByRole('status')).toHaveText('Recorded for RI: applied.');
  const reviewAt = twelveMonthsAfter(stub.asOf);
  expect(reviewAt).toBe('2027-09-18T12:00:00.000Z');
  await expect(row.locator('.state__posture')).toContainText('Posture: calling');
  await expect(row.locator('.state__posture')).toContainText('by David MacBook');
  await expect(row.locator('.state__posture')).toContainText(`review due ${reviewAt.slice(0, 10)}`);
  await expect(row.locator('.state__posture time').nth(1)).toHaveAttribute('datetime', reviewAt);
  expect(stub.postures()).toEqual([{ state: 'RI', posture: 'calling', decidedAt: stub.asOf, decidedBy: 'David MacBook', reviewAt, reviewOverdue: false }]);
  // The other states are untouched; the form stays open with its notice so what was just recorded is still in view.
  await expect(stateRow(page, 'MA').getByText('No posture recorded.', { exact: true })).toBeVisible();
  await expect(form).toBeVisible();
  await expect(form.getByRole('status')).toHaveText('Recorded for RI: applied.');
  await expect(row.getByRole('button', { name: 'Record posture for RI', exact: true })).toHaveCount(0);
});

test('a second posture for the same state keeps the first one under it, newest first', async () => {
  const { page } = client!;
  const row = stateRow(page, 'RI');
  const opener = row.getByRole('button', { name: /posture for RI$/ });
  const form = row.getByRole('form', { name: 'Posture for RI', exact: true });
  // The form stays open after a decision, so the second one is made in the form the first one left open. Waiting
  // for one or the other to be on the page first is what makes that safe: a bare `count()` on the opener is a
  // one-shot read that answers zero while the page's first Settings read is still in flight, and the helper then
  // waits for a form nothing opened. Under load that is exactly what happened.
  const record = async (posture: 'Calling' | 'Not calling') => {
    await expect(opener.or(form).first()).toBeVisible();
    if (await opener.isVisible()) await opener.click();
    await expect(form).toBeVisible();
    await form.getByLabel('Posture', { exact: true }).selectOption({ label: posture });
    await form.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(form.getByRole('status')).toContainText('Recorded for RI');
  };

  // The first decision stands alone: there is nothing behind it to show.
  await record('Calling');
  await expect(row.locator('.state__posture')).toContainText('calling');
  await expect(row.getByRole('list', { name: 'Earlier decisions for RI', exact: true })).toHaveCount(0);

  // The second replaces it and keeps it: the current posture above, what it was before under it.
  await record('Not calling');
  await expect(row.locator('.state__posture')).toContainText('not calling');
  const history = row.getByRole('list', { name: 'Earlier decisions for RI', exact: true });
  await expect(history.locator('li')).toHaveCount(1);
  await expect(history.locator('li').first()).toContainText('calling, decided');
  await expect(history.locator('li').first()).toContainText('by David MacBook');
});

test('adds a state code by hand and refuses one that is not a US postal code', async () => {
  const { page } = client!;
  const add = page.getByRole('form', { name: 'Add a state', exact: true });
  await add.getByLabel('State code', { exact: true }).fill('zz');
  await add.getByRole('button', { name: 'Add state', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('"ZZ" is not a United States postal code.');
  await expect(page.locator('.state')).toHaveCount(3);
  await add.getByLabel('State code', { exact: true }).fill('ct');
  await add.getByRole('button', { name: 'Add state', exact: true }).click();
  await expect(page.locator('.state')).toHaveCount(4);
  const ct = stateRow(page, 'CT');
  await expect(ct.getByRole('heading', { name: 'CT · Connecticut', exact: true })).toBeVisible();
  await expect(ct.getByText('No posture recorded.', { exact: true })).toBeVisible();
  await expect(ct.getByText('No reference text for this state in this build', { exact: false })).toBeVisible();
  // The row opens its form at once; nothing is sent until Record is pressed.
  await expect(ct.getByRole('form', { name: 'Posture for CT', exact: true })).toBeVisible();
  expect(stub.commands).toEqual([]);
});
