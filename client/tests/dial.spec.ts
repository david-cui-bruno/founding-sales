import { rm } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import { startStubWorker, type StubWorker } from './stubWorker';
import { launchClient, newUserData, pairThroughUi, type LaunchedClient } from './support/launchClient';

/**
 * The dial and the outcome form on the real seam (slice S2): the built renderer, preload and main process against
 * the stub worker. Nothing here dials: the specs run an unpackaged build, and the main process refuses a handoff
 * without the packaged, same-team helper and the local setup proof — which is exactly the honest sentence under test.
 *
 * What the specs prove: the Call button follows the worker's own verdict on the card and is dead on a stale list;
 * the outcome form opens after a Call whatever the handoff said, because David may have dialed by hand; recording
 * updates the card from the answer the worker returned; and a never-call takes the firm off the list for good.
 */
let stub: StubWorker;
let userData: string;
let client: LaunchedClient | undefined;

test.beforeEach(async () => {
  stub = await startStubWorker();
  userData = await newUserData();
  client = await launchClient({ endpoint: stub.url, userData });
  await pairThroughUi(client.page, stub);
});

test.afterEach(async () => {
  await client?.close();
  client = undefined;
  await stub.close().catch(() => undefined);
  await rm(userData, { recursive: true, force: true });
});

const openToday = async (page: Page) => {
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true, level: 1 })).toBeVisible();
};
const cardOf = (page: Page, firmId: string) => page.locator(`.today-card[data-firm-id="${firmId}"]`);
const callButton = (page: Page, name: string) => page.getByRole('button', { name: `Call ${name}`, exact: true });
const form = (page: Page, firmId: string) => page.locator(`.outcome-form[data-firm-id="${firmId}"]`);
const outcomes = () => stub.commands.filter((command) => command.kind === 'log_call_outcome');

test('the Call button follows the worker\'s verdict: enabled on an allowed card, dead on one the worker held', async () => {
  const { page } = client!;
  await openToday(page);
  await expect(callButton(page, 'Rhode Island Firm 1')).toBeEnabled();
  // The Texas card reads 06:00 local and the worker held it outside hours; the button says so before anything is pressed.
  await expect(cardOf(page, 'account-tx-1')).toHaveAttribute('data-dial-allowed', 'false');
  await expect(callButton(page, 'Lone Star Living')).toBeDisabled();
  // A card with no phone route offers neither Call nor Copy number.
  const noPhone = structuredClone(stub.today);
  noPhone.list!.lanes.new[0]!.phone = null;
  stub.setToday(noPhone);
  await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();
  await expect(callButton(page, 'Rhode Island Firm 1')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy number for Rhode Island Firm 1', exact: true })).toHaveCount(0);
});

test('every Call button is dead once the list is stale, and no dial is attempted from it', async () => {
  const { page } = client!;
  await openToday(page);
  await expect(callButton(page, 'Rhode Island Firm 1')).toBeEnabled();
  // Stopping the worker leaves the last good list standing, shown as stale; a dial from it is refused, so the button is dead.
  await stub.close();
  await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();
  await expect(page.locator('.today-stale')).toBeVisible();
  await expect(callButton(page, 'Rhode Island Firm 1')).toBeDisabled();
  await expect(callButton(page, 'Lone Star Living')).toBeDisabled();
});

test('Call opens the outcome form inline with the handoff\'s own sentence, and this unpackaged build has no phone route', async () => {
  const { page } = client!;
  await openToday(page);
  await callButton(page, 'Rhode Island Firm 1').click();
  const inline = form(page, 'account-ri-1');
  await expect(inline).toBeVisible();
  // The honest sentence: nothing was dialed, and the reason is the missing local setup, not a silent nothing.
  await expect(inline.getByText('The Phone.app handoff is not set up on this Mac, so nothing was dialed.', { exact: true })).toBeVisible();
  // The ten outcomes, one note, one callback date, the never-call checkbox and one Record button.
  await expect(inline.locator('.outcome-form__outcome')).toHaveCount(10);
  await expect(inline.getByRole('button', { name: 'Record', exact: true })).toHaveCount(1);
  await expect(inline.getByRole('button', { name: 'Voicemail', exact: true })).toBeVisible();
  await expect(inline.getByRole('button', { name: 'Asked to stop', exact: true })).toBeVisible();
  // Recording is refused, with a sentence, until the draft says what happened.
  await inline.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(inline.locator('.outcome-form__problem')).toHaveAttribute('data-problem', 'outcome_missing');
  expect(outcomes()).toHaveLength(0);
  await inline.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form(page, 'account-ri-1')).toHaveCount(0);
});

test('the outcome form records one call and the card updates from the answer the worker returned', async () => {
  const { page } = client!;
  await openToday(page);
  await callButton(page, 'Rhode Island Firm 1').click();
  const inline = form(page, 'account-ri-1');
  await inline.getByRole('button', { name: 'Voicemail', exact: true }).click();
  await inline.locator('.outcome-form__note textarea').fill('Left a message with the front desk.');
  await inline.getByRole('button', { name: 'Record', exact: true }).click();
  // The form closes and the card carries the outcome and the note, from the returned slice.
  await expect(form(page, 'account-ri-1')).toHaveCount(0);
  // Exactly one command, carrying the note and no callback date, and one command id.
  expect(outcomes()).toHaveLength(1);
  const [command] = outcomes();
  // The day is this Mac's own, read off the command rather than pinned: a pinned date fails after midnight UTC.
  const day = command?.kind === 'log_call_outcome' ? command.observedAt.slice(0, 10) : 'no command';
  await expect(cardOf(page, 'account-ri-1').locator('.today-card__outcome'))
    .toHaveText(`Last outcome: voicemail on ${day} — Left a message with the front desk.`);
  expect(command).toMatchObject({ kind: 'log_call_outcome', firmId: 'account-ri-1', outcome: 'voicemail', note: 'Left a message with the front desk.' });
  expect(command && 'callbackOn' in command).toBe(false);
  expect(command && 'neverCall' in command).toBe(false);
});

test('a promised callback records its day and the card says so', async () => {
  const { page } = client!;
  await openToday(page);
  await callButton(page, 'Rhode Island Firm 1').click();
  const inline = form(page, 'account-ri-1');
  await inline.getByRole('button', { name: 'Callback', exact: true }).click();
  // A callback with no day is refused rather than recorded without one.
  await inline.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(inline.locator('.outcome-form__problem')).toHaveAttribute('data-problem', 'callback_date_missing');
  expect(outcomes()).toHaveLength(0);
  await inline.locator('.outcome-form__callback input').fill('2026-09-22');
  await inline.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(cardOf(page, 'account-ri-1').locator('.today-card__callback')).toHaveText('Callback promised for 2026-09-22');
  expect(outcomes()).toHaveLength(1);
  expect(outcomes()[0]).toMatchObject({ outcome: 'callback', callbackOn: '2026-09-22' });
});

test('never call this firm warns, needs a reason, and takes the card off the list for good', async () => {
  const { page } = client!;
  await openToday(page);
  await expect(cardOf(page, 'account-ri-1')).toBeVisible();
  await callButton(page, 'Rhode Island Firm 1').click();
  const inline = form(page, 'account-ri-1');
  await inline.getByRole('button', { name: 'Answered, not interested', exact: true }).click();
  await inline.locator('.outcome-form__never input[type="checkbox"]').check();
  await expect(inline.locator('.outcome-form__warning')).toHaveText('Recording this suppresses Rhode Island Firm 1 for good. There is no undo.');
  // A permanent decision is never taken without David's own words for it.
  await inline.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(inline.locator('.outcome-form__problem')).toHaveAttribute('data-problem', 'never_call_reason_missing');
  expect(outcomes()).toHaveLength(0);
  await inline.locator('.outcome-form__never-reason input').fill('Managing partner asked us never to call again.');
  await inline.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(cardOf(page, 'account-ri-1')).toHaveCount(0);
  await expect(page.getByText('0 replies · 0 callbacks · 1 due · 2 new · pool 2', { exact: true })).toHaveCount(0);
  expect(outcomes()).toHaveLength(1);
  expect(outcomes()[0]).toMatchObject({ outcome: 'answered_not_interested', neverCall: { reason: 'Managing partner asked us never to call again.' } });
});

test('a card opens one firm\'s page, which reads the Firm view and has no Call button of its own', async () => {
  const { page } = client!;
  await openToday(page);
  await expect(cardOf(page, 'account-ri-1').locator('.today-card__open-firm')).toHaveAttribute('data-firm-route', '/firms/account-ri-1');
  await page.getByRole('button', { name: 'Open Rhode Island Firm 1', exact: true }).click();
  const firm = page.locator('.page--firm');
  await expect(firm).toHaveAttribute('data-firm-route', '/firms/account-ri-1');
  await expect(page.getByRole('heading', { name: 'Rhode Island Firm 1', exact: true, level: 1 })).toBeVisible();
  await expect(firm.locator('.firm__routes li')).toHaveCount(1);
  await expect(firm.locator('.firm__routes li')).toContainText('+14015550201 (phone, listed)');
  await expect(firm.locator('.firm__status')).toHaveAttribute('data-status', 'new');
  await expect(firm.locator('.firm__calls')).toHaveCount(0);
  await expect(firm.getByText('No call logged.', { exact: true })).toBeVisible();
  // Reading a firm is never a dial: this page carries no Call button and no outcome form.
  await expect(page.getByRole('button', { name: 'Call Rhode Island Firm 1', exact: true })).toHaveCount(0);
  await expect(page.locator('.outcome-form')).toHaveCount(0);
  expect(stub.requests.filter((request) => request.path === '/v1/firms')).toHaveLength(1);
  await page.getByRole('button', { name: 'Back to Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true, level: 1 })).toBeVisible();
});

test('Add a firm refuses an incomplete entry and sends one add_firm command for a complete one', async () => {
  const { page } = client!;
  await openToday(page);
  const add = page.locator('form.add-firm');
  await expect(add).toBeVisible();
  await add.getByRole('button', { name: 'Add firm', exact: true }).click();
  await expect(add.locator('.add-firm__problem')).toHaveAttribute('data-problem', 'name_missing');
  await add.getByLabel('Firm name', { exact: true }).fill('Hope Street Management');
  await add.getByLabel('City', { exact: true }).fill('Providence');
  await add.getByRole('button', { name: 'Add firm', exact: true }).click();
  await expect(add.locator('.add-firm__problem')).toHaveAttribute('data-problem', 'state_missing');
  await add.getByLabel('State', { exact: true }).selectOption('RI');
  await add.getByRole('button', { name: 'Add firm', exact: true }).click();
  await expect(add.locator('.add-firm__problem')).toHaveAttribute('data-problem', 'route_missing');
  expect(stub.commands.filter((command) => command.kind === 'add_firm')).toHaveLength(0);
  await add.getByLabel('Phone', { exact: true }).fill('(401) 555-0230');
  await add.getByRole('button', { name: 'Add firm', exact: true }).click();
  await expect.poll(() => stub.commands.filter((command) => command.kind === 'add_firm').length).toBe(1);
  expect(stub.commands.find((command) => command.kind === 'add_firm')).toMatchObject({ kind: 'add_firm',
    name: 'Hope Street Management', city: 'Providence', state: 'RI', phone: '(401) 555-0230' });
});
