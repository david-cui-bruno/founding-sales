import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import { startStubWorker, type StubWorker } from './stubWorker';
import { clientFile, launchClient, newUserData, openDiagnostics, pairThroughUi, type LaunchedClient } from './support/launchClient';

/**
 * The Diagnostics page on the real seam: the last twenty attempts newest first with their closed detail as
 * chips, the kind filter re-reading through the worker, Revoke this device issuing a `revoke_device`
 * command with a fresh UUID v4 commandId, and the last good `/v1/today` response persisted on disk.
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
  // Today is the landing page; these specs are about Diagnostics, so they navigate there through the rail.
  await openDiagnostics(client.page);
});

test.afterEach(async () => {
  await client?.close();
  client = undefined;
  await stub.close();
  await rm(userData, { recursive: true, force: true });
});

const attemptRows = (page: Page) => page.getByRole('table', { name: 'Attempts', exact: true }).locator('tbody tr');
const diagnosticsReads = () => stub.requests.filter(request => request.method === 'GET' && request.path === '/v1/diagnostics');

test('shows the last 20 attempts newest first with the closed detail as chips and the as-of stamp', async () => {
  const { page } = client!;
  const rows = attemptRows(page);
  await expect(rows).toHaveCount(20);
  const stamps = await rows.locator('td:nth-child(1) time').evaluateAll(nodes => nodes.map(node => node.getAttribute('datetime')));
  expect(stamps).toEqual(stub.attempts().map(attempt => attempt.at));
  expect([...stamps].sort().reverse()).toEqual(stamps);

  const newest = stub.attempts()[0]!;
  await expect(rows.first()).toContainText(newest.kind);
  await expect(rows.first()).toContainText(newest.outcome);
  for (const [key, value] of Object.entries(newest.detail ?? {})) {
    await expect(rows.first().getByText(`${key}: ${value}`, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(`as of ${stub.asOf}`, { exact: false })).toBeVisible();
  // Only the status, the Today landing read and the diagnostics read happen on mount: no command, no other view.
  expect(stub.requests.filter(request => request.method === 'POST' && request.path !== '/v1/pair/redeem')).toEqual([]);
  expect(stub.requests.filter(request => request.method === 'GET').every(request => request.path === '/v1/diagnostics' || request.path === '/v1/today')).toBe(true);
  expect(diagnosticsReads().length).toBeGreaterThan(0);
});

test('the kind filter narrows the list through the worker', async () => {
  const { page } = client!;
  await expect(attemptRows(page)).toHaveCount(20);
  await page.getByLabel('Kind', { exact: true }).selectOption('command');
  const expected = stub.attempts().filter(attempt => attempt.kind === 'command');
  expect(expected.length).toBeGreaterThan(0);
  expect(expected.length).toBeLessThan(20);
  await expect(attemptRows(page)).toHaveCount(expected.length);
  expect(diagnosticsReads().some(request => request.query.get('kind') === 'command')).toBe(true);
  await page.getByLabel('Kind', { exact: true }).selectOption('');
  await expect(attemptRows(page)).toHaveCount(20);
});

test('Revoke this device on another device sends revoke_device with a fresh UUID v4 commandId and refreshes', async () => {
  const { page } = client!;
  const [first, second] = stub.otherDevices();
  const readsBefore = diagnosticsReads().length;

  const firstRow = page.getByRole('row', { name: first!.label });
  await expect(firstRow.getByRole('button', { name: 'Revoke this device', exact: true })).toBeVisible();
  // The paired device itself offers no Revoke button: Unpair is the way to stop this Mac.
  const [own] = stub.pairedDevices();
  await expect(page.getByRole('row', { name: own!.label }).getByRole('button', { name: 'Revoke this device', exact: true })).toHaveCount(0);

  await firstRow.getByRole('button', { name: 'Revoke this device', exact: true }).click();
  await expect.poll(() => stub.commands.length).toBe(1);
  expect(stub.commands[0]).toMatchObject({ kind: 'revoke_device', deviceId: first!.deviceId });
  expect(stub.commands[0]!.commandId).toMatch(UUID_V4);
  // The page re-read Diagnostics after the command and shows the revocation the worker recorded.
  await expect(firstRow.getByText(/^revoked /)).toBeVisible();
  await expect(firstRow.getByRole('button', { name: 'Revoke this device', exact: true })).toHaveCount(0);
  await expect.poll(() => diagnosticsReads().length).toBeGreaterThan(readsBefore);

  const secondRow = page.getByRole('row', { name: second!.label });
  await secondRow.getByRole('button', { name: 'Revoke this device', exact: true }).click();
  await expect.poll(() => stub.commands.length).toBe(2);
  expect(stub.commands[1]!.commandId).toMatch(UUID_V4);
  expect(stub.commands[1]!.commandId).not.toBe(stub.commands[0]!.commandId);
  // Every command the client sent carried the device's bearer token.
  expect(stub.requests.filter(request => request.path === '/v1/commands').every(request => request.authenticated)).toBe(true);
});

test('a successful /v1/today read writes the last-good file with its fetched-at stamp', async () => {
  const { page } = client!;
  const lastGood = clientFile(userData, 'today-last-good.json');
  // The Today landing page already read once and wrote the file; a read through the bridge rewrites it with its own stamp.
  expect(existsSync(lastGood)).toBe(true);
  const result = await page.evaluate(() => window.callie.get({ view: '/v1/today' }));
  expect(result.outcome).toBe('ok');
  if (result.outcome !== 'ok') return;
  expect(Number.isNaN(Date.parse(result.fetchedAt))).toBe(false);
  const persisted = JSON.parse(readFileSync(lastGood, 'utf8'));
  expect(persisted).toEqual({ fetchedAt: result.fetchedAt, view: stub.today });
});
