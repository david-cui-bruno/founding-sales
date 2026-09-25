import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attestCallingIdentityCommandSchema,
  compareVersions,
  mayMutate,
  registerCallingIdentityCommandSchema,
} from '@fss/contracts';
import { CALLING_IDENTITY_PATHS } from '../../apps/api/src/routes/callingIdentities.ts';
import { CONTAINER_CLIENT_VERSIONS } from '../../apps/api/src/bootstrap/main.ts';
import { createAuthedClient } from '../../apps/desktop/src/main/authedClient.ts';
import type { HttpAnswer } from '../../apps/desktop/src/main/apiClient.ts';
import {
  ADMIN_IPC_CHANNELS,
  CALLING_NUMBER_API_PATHS,
  createAdminBridge,
} from '../../apps/desktop/src/main/settingsBridge.ts';
import { adminViewOf } from '../../apps/desktop/src/renderer/settingsView.ts';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * A salesperson can give Callie the number they call from (9.1; lane g60).
 *
 * On 24 September 2026 production's only salesperson could sign in, connect Gmail and
 * read Today, and could not place a call: 9.2's second step refuses every dial whose
 * calling identity is not "active, verified and owned by the actor", the Today card
 * offers a Call button only when it carries such an identity, and nothing anywhere — no
 * domain function, no route, no control — created or verified one. The restore drill's
 * dial probe had no subject for the same reason. This check is the question nobody
 * asked, in the release suite so a build without the answer cannot be the one released.
 *
 * ## The vacuous-pass traps, named
 *
 * **A check that the words exist.** Asserting that the settings bridge mentions
 * `/calling-identities/register` would pass against a control that registers the number
 * and never attests it — which, from David's side, is still no Call button. Closed by
 * driving the bridge against a scripted API and asserting the sequence: the read, the
 * registration, the attestation, the read that shows the number in use.
 *
 * **An attestation nobody made.** The attestation is the whole of version one's
 * verification, so a control that sent it without the person ticking the statement
 * would be the page verifying the number on their behalf. Closed by driving the
 * unticked press and asserting that no attestation was sent.
 *
 * **A control nobody can reach.** The bridge can be perfect and the window still have no
 * way to it if the preload stops exposing it or the main process stops answering its
 * channel. Those are Electron wiring and cannot run here, so the exact lines are
 * asserted, and a mutation removes the preload's.
 *
 * **A build the API refuses.** The control ships in desktop 1.0.2, and a client above
 * the API's published maximum is refused every sign-in, renewal and command. The
 * maximum is read from the constant the container serves.
 *
 * **A second way to become verified.** A seed, a tool or a later lane could make the
 * drill pass, or David's card callable, with an `INSERT` of a verified row. Migration
 * 0016's CHECK refuses a verified row without its attestation; this check adds that the
 * only application code that writes the table at all is the domain module that records
 * one.
 */

const IDENTITY_ID = '66666666-6666-4666-8666-666666666666';
const FIRST_VERSION_WITH_THE_CONTROL = '1.0.2';

const identity = (overrides: Record<string, unknown> = {}) => ({
  id: IDENTITY_ID,
  ownerUserId: '11111111-1111-4111-8111-111111111111',
  e164: '+14015550150',
  label: null,
  verificationStatus: 'unverified',
  enabled: false,
  verifiedAt: null,
  verifiedByUserId: null,
  verificationMethod: null,
  disabledAt: null,
  usedForCalls: false,
  createdAt: '2026-09-25T12:00:00.000Z',
  ...overrides,
});

const attested = identity({
  verificationStatus: 'verified',
  enabled: true,
  verifiedAt: '2026-09-25T12:01:00.000Z',
  verifiedByUserId: '11111111-1111-4111-8111-111111111111',
  verificationMethod: 'owner_attestation',
  usedForCalls: true,
});

function settingsWindow(role: 'admin' | 'salesperson' = 'admin') {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const lists: HttpAnswer[] = [
    { status: 200, body: { identities: [] } },
    { status: 200, body: { identities: [attested] } },
  ];
  const bridge = createAdminBridge({
    api: createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: FIRST_VERSION_WITH_THE_CONTROL,
      accessToken: async () => await Promise.resolve('token-value'),
      send: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ method: init.method, path, body: init.body === undefined ? null : JSON.parse(init.body) });
        if (path === CALLING_NUMBER_API_PATHS.list) {
          return await Promise.resolve(lists.length > 1 ? (lists.shift() as HttpAnswer) : (lists[0] as HttpAnswer));
        }
        if (path === CALLING_NUMBER_API_PATHS.register) {
          return await Promise.resolve({
            status: 200,
            body: { status: 'accepted', replayed: false, result: { outcome: 'created', identity: identity() } },
          });
        }
        if (path === CALLING_NUMBER_API_PATHS.attest) {
          return await Promise.resolve({
            status: 200,
            body: { status: 'accepted', replayed: false, result: { outcome: 'verified', identity: attested } },
          });
        }
        return await Promise.resolve({ status: 404, body: { error: 'not_found' } });
      },
    }),
    session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role } }) },
  });
  return { bridge, calls };
}

/** Every `.ts` file under a directory, skipping dependencies and test code. */
function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === 'test' || name === 'testing') continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('9.1: a salesperson gives Callie the number they call from (lane g60)', () => {
  it('registers and attests the number from the Settings screen, and the page then names it as the one Today calls from', async () => {
    const { bridge, calls } = settingsWindow('salesperson');
    const before = await bridge.state();
    // Where David was: no number, and a page that says why there is no Call button.
    expect(adminViewOf(before).callingNumber.summary).toContain('Today has no Call button');
    expect(adminViewOf(before).callingNumber.canAdd).toBe(true);

    const after = await bridge.addCallingNumber({ e164: '+1 401 555 0150', label: '', attested: true });

    const numbers = calls.filter(call => call.path.startsWith('/calling-identities'));
    expect(numbers.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /calling-identities',
      'POST /calling-identities/register',
      'POST /calling-identities/attest',
      'GET /calling-identities',
    ]);
    expect(registerCallingIdentityCommandSchema.safeParse(numbers[1]?.body).success).toBe(true);
    expect(attestCallingIdentityCommandSchema.safeParse(numbers[2]?.body).success).toBe(true);
    expect(numbers[2]?.body).toMatchObject({ identityId: IDENTITY_ID, attested: true });
    expect(adminViewOf(after).callingNumber.summary).toBe('Today calls from +14015550150.');
  });

  it('never attests a number the person did not attest', async () => {
    const { bridge, calls } = settingsWindow();
    await bridge.state();
    await bridge.addCallingNumber({ e164: '+14015550150', label: '', attested: false });
    expect(calls.map(call => call.path)).toContain(CALLING_NUMBER_API_PATHS.register);
    expect(calls.map(call => call.path)).not.toContain(CALLING_NUMBER_API_PATHS.attest);
  });

  it('calls only paths the API mounts', () => {
    for (const path of Object.values(CALLING_NUMBER_API_PATHS)) expect(CALLING_IDENTITY_PATHS).toContain(path);
  });

  it('is reachable from the window: the preload exposes it, the main process answers it, the page renders it', () => {
    const preload = readRepositoryFile('apps/desktop/src/preload/preload.ts');
    expect(preload).toContain(
      '  addCallingNumber: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.addCallingNumber, input),\n',
    );
    expect(preload).toContain(
      '  attestCallingNumber: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.attestCallingNumber, input),\n',
    );
    expect(preload).toContain("contextBridge.exposeInMainWorld('callieAdmin', admin);\n");

    const window = readRepositoryFile('apps/desktop/src/main/settingsWindow.ts');
    expect(window).toContain('  handleOnce(ADMIN_IPC_CHANNELS.addCallingNumber, async argument => {\n');
    expect(window).toContain('  handleOnce(ADMIN_IPC_CHANNELS.attestCallingNumber, async argument => {\n');
    expect(readRepositoryFile('apps/desktop/src/main/app.ts')).toContain('  registerAdminBridge({ api, session });\n');

    const page = readRepositoryFile('apps/desktop/src/renderer/settingsPage.ts');
    expect(page).toContain('  renderCallingNumber(root, view);\n');
    expect(page).toContain('bridge().addCallingNumber({ e164: number.value, label: label.value, attested: attested.checked })');

    expect(ADMIN_IPC_CHANNELS.addCallingNumber).toBe('callie:admin:add-calling-number');
  });

  it('is a build the deployed API accepts', () => {
    expect(compareVersions(CONTAINER_CLIENT_VERSIONS.maximum, FIRST_VERSION_WITH_THE_CONTROL)).toBeGreaterThanOrEqual(0);
    expect(mayMutate(CONTAINER_CLIENT_VERSIONS, FIRST_VERSION_WITH_THE_CONTROL)).toBe(true);
    // The installed 1.0.1 keeps working until it takes the update.
    expect(CONTAINER_CLIENT_VERSIONS.minimum).toBe('1.0.0');
  });

  it('has one writer: the domain module that records an attestation', () => {
    const writers = ['apps/api/src', 'apps/worker/src', 'apps/desktop/src', 'packages/domain', 'packages/contracts/src']
      .flatMap(directory => sourceFiles(repositoryPath(directory)))
      .filter(path => /\b(INSERT\s+INTO|UPDATE)\s+calling_identities\b/u.test(readRepositoryFile(relative(repositoryPath('.'), path))))
      .map(path => relative(repositoryPath('.'), path));
    expect(writers).toEqual(['packages/domain/dial/identities.ts']);
  });
});
