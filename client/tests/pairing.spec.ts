import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { expect, test } from 'playwright/test';
import { startStubWorker, type StubWorker } from './stubWorker';
import { clientFile, codeField, launchClient, newUserData, pairButton, pairThroughUi, type LaunchedClient } from './support/launchClient';

/**
 * Pairing on the real seam: the built renderer, preload and main process of the client against the stub
 * worker, with a fresh userData directory per test. The token file is the safeStorage-encrypted file the
 * main process writes; the spec checks it exists, never carries the token in clear, and disappears when
 * the worker refuses the device or the user unpairs.
 */
let stub: StubWorker;
let userData: string;
let client: LaunchedClient | undefined;

test.beforeEach(async () => {
  stub = await startStubWorker();
  userData = await newUserData();
});

test.afterEach(async () => {
  await client?.close();
  client = undefined;
  await stub.close();
  await rm(userData, { recursive: true, force: true });
});

const tokenFile = () => clientFile(userData, 'device-token.bin');

test('a wrong code shows the refusal, the right code pairs, and a restart keeps the pairing', async () => {
  client = await launchClient({ endpoint: stub.url, userData });
  const { page } = client;
  await expect(page.getByRole('heading', { name: 'Pair this Mac', exact: true })).toBeVisible();
  await expect(page.getByText(`Worker: ${stub.url}`, { exact: true })).toBeVisible();

  await codeField(page).fill(stub.unknownCode());
  await pairButton(page).click();
  await expect(page.getByRole('alert')).toHaveText('The worker refused this code: code_unknown.');
  expect(existsSync(tokenFile())).toBe(false);
  expect(stub.pairedDevices()).toEqual([]);

  const code = stub.mintCode('David MacBook');
  await codeField(page).fill(code);
  await pairButton(page).click();
  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
  const [device] = stub.pairedDevices();
  expect(device?.label).toBe('David MacBook');
  expect(existsSync(tokenFile())).toBe(true);
  // The file is safeStorage-encrypted: the token the stub issued never appears in it.
  expect(readFileSync(tokenFile()).includes(Buffer.from(device!.token, 'utf8'))).toBe(false);
  // The consumed code is not accepted twice, and the client never sent the token anywhere but the worker.
  expect(stub.requests.filter(request => request.path === '/v1/pair/redeem')).toHaveLength(2);

  await client.close();
  client = await launchClient({ endpoint: stub.url, userData });
  await expect(client.page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
  await expect(client.page.getByRole('heading', { name: 'Pair this Mac', exact: true })).toHaveCount(0);
  // The restart used the stored token: no second redeem.
  expect(stub.requests.filter(request => request.path === '/v1/pair/redeem')).toHaveLength(2);
});

test('a path to the code file pairs and the file is deleted after the redeem', async () => {
  client = await launchClient({ endpoint: stub.url, userData });
  const { page } = client;
  const codePath = await stub.writeCodeFile('David MacBook', userData);
  await codeField(page).fill(codePath);
  await pairButton(page).click();
  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
  expect(existsSync(codePath)).toBe(false);
  expect(stub.pairedDevices()).toHaveLength(1);
});

test('a 401 device_expired from the worker returns to Pair with the sentence and forgets the token', async () => {
  client = await launchClient({ endpoint: stub.url, userData });
  const { page } = client;
  await pairThroughUi(page, stub);
  const [device] = stub.pairedDevices();
  stub.expireDevice(device!.deviceId);

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pair this Mac', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('The worker refused this device: its token expired. Pair again with a new code.');
  expect(existsSync(tokenFile())).toBe(false);

  await client.close();
  client = await launchClient({ endpoint: stub.url, userData });
  await expect(client.page.getByRole('heading', { name: 'Pair this Mac', exact: true })).toBeVisible();
});

test('Unpair forgets the pairing', async () => {
  client = await launchClient({ endpoint: stub.url, userData });
  const { page } = client;
  await pairThroughUi(page, stub);
  expect(existsSync(tokenFile())).toBe(true);

  await page.getByRole('button', { name: 'Unpair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pair this Mac', exact: true })).toBeVisible();
  expect(existsSync(tokenFile())).toBe(false);

  await client.close();
  client = await launchClient({ endpoint: stub.url, userData });
  await expect(client.page.getByRole('heading', { name: 'Pair this Mac', exact: true })).toBeVisible();
});
