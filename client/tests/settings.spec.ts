import { rm } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import { startStubWorker, STUB_DESCRIPTOR_EXPIRES_AT, STUB_MAILBOX, STUB_POSTAL_ADDRESS, type StubWorker } from './stubWorker';
import { launchClient, newUserData, pairThroughUi, type LaunchedClient } from './support/launchClient';

/**
 * Every Settings section slice S5 added, on the real seam: the built client as an Electron app against the stub
 * worker. Each section renders from the stub's answer, and one command per control updates the section it changed
 * because the page re-reads Settings after every applied command.
 *
 * Nothing here sends, dials or books. Approving a template is not sending, confirming the phone setup is not
 * dialing, and narrowing the call hours is not permission to call: the checks below are that the control records
 * what David decided and that the page shows him what the worker now holds.
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

const section = (page: Page, id: string) => page.locator(`.settings__section[data-section="${id}"]`);
const lastCommand = (kind: string) => [...stub.commands].reverse().find((command) => command.kind === kind);

test('renders every section from the stub: templates, sending, calls, phone, google, research, devices and pause', async () => {
  const { page } = client!;
  // Templates: the five the worker holds, one of them approved with its footer present.
  const templates = section(page, 'templates');
  await expect(templates.locator('.template')).toHaveCount(5);
  await expect(templates.locator('.template[data-template="T4"] .template__state')).toContainText('Approved');
  await expect(templates.locator('.template[data-template="T4"] .template__state')).toContainText('footer present');
  await expect(templates.locator('.template[data-template="T1"] .template__state')).toContainText('Not approved');
  await expect(templates.locator('.template[data-template="T1"] .template__state')).toContainText('footer missing');
  await expect(templates.locator('.template[data-template="T1"] .template__state')).toContainText('template_footer_missing');

  // Sending: the cap line, the ceiling fixed in code, and the postal address the footer carries.
  const sending = section(page, 'sending');
  await expect(sending.locator('.sending__cap')).toContainText('Cap today (2026-09-18): 12');
  await expect(sending.locator('.sending__cap')).toContainText('5 used, 7 left');
  await expect(sending.locator('.sending__ceiling')).toContainText('Ceiling fixed in code: 40 a day');
  await expect(sending.getByLabel('Postal address', { exact: true })).toHaveValue(STUB_POSTAL_ADDRESS);

  // Calls: the code floor said plainly beside David's own hours.
  const calls = section(page, 'calls');
  await expect(calls.locator('.calls__floor')).toHaveText('Fixed in code: Monday to Friday, 08:00 to 20:00 local to the firm.');
  await expect(calls.locator('.calls__window')).toHaveText('Your hours: 08:00 to 20:00.');

  // Phone setup: the worker has no confirmation, and this Mac is unpackaged, so it has no helper to confirm.
  const phone = section(page, 'phone');
  await expect(phone.locator('.phone__worker')).toHaveText('Worker: not confirmed.');
  await expect(phone.locator('.phone__local')).toContainText('This Mac has no phone route');
  await expect(phone.getByRole('button', { name: 'Confirm phone setup', exact: true })).toBeDisabled();

  // Google: a status only. There is no "connect" button on this page; that is its own step.
  const google = section(page, 'google');
  await expect(google.locator('.google__status')).toContainText('connected');
  await expect(google.locator('.google__status')).toContainText(STUB_MAILBOX);
  await expect(google.locator('p.page__tick').last()).toContainText('replaced by a fresh consent at cutover');

  // Research: the review window David has to renew, with the date on it, plus the budget and the grid.
  const research = section(page, 'research');
  await expect(research.locator('.research__descriptor')).toHaveAttribute('data-descriptor', 'reviewed');
  await expect(research.locator('.research__descriptor')).toHaveText(`Operator review: valid until ${STUB_DESCRIPTOR_EXPIRES_AT.slice(0, 10)}, reviewed 2026-09-01.`);
  await expect(research.locator('.research__budget')).toContainText('Today (2026-09-18): 12 of 45 used, 33 left.');
  await expect(research.locator('.research__budget')).toContainText('ceiling fixed in code 200');
  await expect(research.locator('.research__queries')).toHaveText('3 queries in the grid · revision 4.');

  // Devices: this Mac and the two the stub holds beside it.
  await expect(section(page, 'devices').locator('.device')).toHaveCount(3);
  await expect(section(page, 'devices').getByText('David MacBook', { exact: true })).toBeVisible();

  // Pause: not paused, and no banner anywhere.
  await expect(section(page, 'paused').locator('.paused__state')).toContainText('Not paused.');
  await expect(page.locator('.paused-banner')).toHaveCount(0);

  // Reading Settings sends no command at all.
  expect(stub.commands).toEqual([]);
});

test('narrowing the call hours sends set_call_policy with a fresh UUID v4 and the section shows the new hours', async () => {
  const { page } = client!;
  const calls = section(page, 'calls');
  await calls.getByLabel('Start', { exact: true }).fill('09:00');
  await calls.getByLabel('End', { exact: true }).fill('17:00');
  await calls.getByRole('button', { name: 'Save call hours', exact: true }).click();
  await expect(calls.locator('.calls__window')).toHaveText('Your hours: 09:00 to 17:00.');

  const command = lastCommand('set_call_policy');
  expect(command).toMatchObject({ kind: 'set_call_policy', window: { startMinute: 540, endMinute: 1020 } });
  expect(command?.commandId).toMatch(UUID_V4);
  // The page re-read Settings after the command, which is how the section above is the worker's answer.
  expect(stub.requests.filter((request) => request.method === 'GET' && request.path === '/v1/settings').length).toBeGreaterThan(1);
});

test('hours the code floor does not contain are refused by the worker and the page says so without changing the section', async () => {
  const { page } = client!;
  const calls = section(page, 'calls');
  await calls.getByLabel('Start', { exact: true }).fill('07:00');
  await calls.getByRole('button', { name: 'Save call hours', exact: true }).click();
  await expect(calls.getByRole('alert')).toContainText('call_policy_outside_floor');
  await expect(calls.locator('.calls__window')).toHaveText('Your hours: 08:00 to 20:00.');
});

test('pause writes the reason, puts the banner on every page, and resume takes it away', async () => {
  const { page } = client!;
  const paused = section(page, 'paused');
  await paused.getByLabel('Reason', { exact: true }).fill('Phone-only stop rehearsal');
  await paused.getByRole('button', { name: 'Pause', exact: true }).click();

  await expect(page.locator('.paused-banner')).toHaveText('Paused: Phone-only stop rehearsal');
  await expect(section(page, 'paused').locator('.paused__state')).toContainText('Paused: Phone-only stop rehearsal');
  expect(lastCommand('pause')).toMatchObject({ kind: 'pause', reason: 'Phone-only stop rehearsal' });

  // The banner belongs to the shell, so it is on Today and on the Week page too.
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.locator('.paused-banner')).toHaveText('Paused: Phone-only stop rehearsal');
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.locator('.paused-banner')).toHaveText('Paused: Phone-only stop rehearsal');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const resume = section(page, 'paused');
  await expect(resume.getByRole('heading', { name: 'Resume', exact: true })).toBeVisible();
  await resume.getByLabel('Reason', { exact: true }).fill('rehearsal over');
  await resume.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.locator('.paused-banner')).toHaveCount(0);
  await expect(section(page, 'paused').locator('.paused__state')).toContainText('Not paused.');
  expect(lastCommand('resume')).toMatchObject({ kind: 'resume', reason: 'rehearsal over' });
});

test('approving a template sends the exact text with the revision the page read, and the footer rule refuses a body without one', async () => {
  const { page } = client!;
  const templates = section(page, 'templates');
  const row = templates.locator('.template[data-template="T1"]');
  await templates.getByRole('button', { name: 'Approve T1', exact: true }).click();
  const form = templates.getByRole('form', { name: 'Approve T1', exact: true });
  await expect(form.getByLabel('Subject', { exact: true })).toHaveValue('Fictional subject T1');

  // The seeded body ends at the sign-off, with no postal address and no stop line: the worker refuses it.
  await form.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('template_footer_missing');
  await expect(row.locator('.template__state')).toContainText('Not approved');

  // The same text with the footer block is David's standing approval, and the section shows it as approved.
  const footer = await page.evaluate(() => document.querySelector('.sending__cap') !== null);
  expect(footer).toBe(true);
  const body = await form.getByLabel('Body', { exact: true }).inputValue();
  await form.getByLabel('Body', { exact: true }).fill(`${body}\n${STUB_POSTAL_ADDRESS}\nReply "stop" and I will not email you again.`);
  await form.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(row.locator('.template__state')).toContainText('Approved');
  await expect(row.locator('.template__state')).toContainText('footer present');

  const command = lastCommand('approve_template');
  expect(command).toMatchObject({ kind: 'approve_template', templateId: 'T1', expectedRevision: 1, subject: 'Fictional subject T1' });
  expect(command?.commandId).toMatch(UUID_V4);
  // Approving is never sending: nothing but commands and reads crossed to the worker.
  expect(stub.requests.filter((request) => request.method === 'POST' && !['/v1/commands', '/v1/pair/redeem'].includes(request.path))).toEqual([]);
});

test('clearing the phone setup sends clear_phone_setup and confirming is refused on a Mac with no helper', async () => {
  const { page } = client!;
  const phone = section(page, 'phone');
  await phone.getByRole('button', { name: 'Clear phone setup', exact: true }).click();
  await expect(phone.locator('.phone__worker')).toHaveText('Worker: not confirmed.');
  expect(lastCommand('clear_phone_setup')).toMatchObject({ kind: 'clear_phone_setup' });
  // Confirm is not offered at all here: this Mac has no packaged helper, so there is no proof to confirm.
  await expect(phone.getByRole('button', { name: 'Confirm phone setup', exact: true })).toBeDisabled();
  expect(lastCommand('confirm_phone_setup')).toBeUndefined();
});

test('revoking another device sends revoke_device and the section drops its Revoke button', async () => {
  const { page } = client!;
  const devices = section(page, 'devices');
  const loaner = stub.otherDevices().find((device) => device.label === 'Loaner')!;
  await devices.getByRole('button', { name: 'Revoke Loaner', exact: true }).click();
  await expect(devices.getByRole('button', { name: 'Revoke Loaner', exact: true })).toHaveCount(0);
  expect(lastCommand('revoke_device')).toMatchObject({ kind: 'revoke_device', deviceId: loaner.deviceId });
});
