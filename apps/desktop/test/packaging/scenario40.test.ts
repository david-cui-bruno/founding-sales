import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkForUpdate, CHANNEL_MANIFEST_PATH, signManifest, type UpdateManifest } from '../../src/main/updateChannel.ts';
import { createDesktopFixture, type DesktopFixture } from '../support/desktopFixture.ts';
import { generateUpdateKeyPair, sha256Hex } from '../support/updateKeys.ts';

/**
 * Appendix G scenario 40: "Minimum-client-version increase blocks old Electron
 * mutation while preserving the upgrade path."
 *
 * The block is G2's; the path out of it is this lane's. The two halves have never
 * been exercised together, and the thing worth proving is that they meet: the
 * version the channel offers is high enough to clear the minimum the API raised, and
 * a channel answer that cannot be verified leaves a person blocked rather than
 * installing something unverified to get out of the block. The pressure to accept a
 * bad update is highest exactly when the app is already refusing to work.
 */

const RAISED = { minimum: '2.0.0', maximum: '2.0.0' } as const;
const OLD_CLIENT = '1.4.0';

interface Channel {
  readonly baseUrl: string;
  serve(body: unknown): void;
  readonly requestedPaths: string[];
  close(): Promise<void>;
}

const servers: Server[] = [];
const fixtures: DesktopFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async fixture => { await fixture.stop(); }));
  await Promise.all(
    servers.splice(0).map(
      async server =>
        await new Promise<void>(resolve => {
          server.close(() => { resolve(); });
        }),
    ),
  );
});

async function startChannel(): Promise<Channel> {
  let body: unknown = null;
  const requestedPaths: string[] = [];
  const server = createServer((request, response) => {
    requestedPaths.push(request.url ?? '');
    if (body === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/`,
    serve: value => { body = value; },
    requestedPaths,
    close: async () =>
      await new Promise<void>(resolve => {
        server.close(() => { resolve(); });
      }),
  };
}

function manifestFor(channelBaseUrl: string, releaseVersion: string): UpdateManifest {
  const payload = `Callie ${releaseVersion}`;
  return {
    format: 'fss-desktop-update',
    version: 1,
    channel: 'release',
    releaseVersion,
    commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    publishedAt: '2026-09-20T09:00:00.000Z',
    minimumSystemVersion: '13.0.0',
    artifact: {
      url: `${channelBaseUrl}releases/darwin-arm64/${releaseVersion}/Callie.zip`,
      sizeBytes: Buffer.byteLength(payload),
      sha256: sha256Hex(payload),
    },
  };
}

async function signedInAt(clientVersion: string): Promise<DesktopFixture> {
  const fixture = await createDesktopFixture({ clientVersion, supported: RAISED });
  fixtures.push(fixture);
  await fixture.manager.signIn({ workspaceId: fixture.workspaceId, deviceLabel: "David's Mac" });
  return fixture;
}

describe('scenario 40: the API raises the minimum client version', () => {
  it('blocks every mutation on the old build and leaves the upgrade instruction readable', async () => {
    const fixture = await signedInAt(OLD_CLIENT);

    const state = await fixture.manager.state();
    expect(state.screen).toBe('upgrade_required');
    expect(state.mayMutate).toBe(false);
    expect(state.supportedClientVersions).toEqual(RAISED);

    await expect(fixture.manager.mayMutateNow()).resolves.toEqual({
      allowed: false,
      refusal: 'client_upgrade_required',
    });

    // The one thing an outdated client may read.
    const notice = await fixture.api.clientVersionNotice();
    expect(notice.ok).toBe(true);
    if (notice.ok) expect(notice.value.supported).toEqual(RAISED);
  });

  it('offers exactly one way out: a signed build at or above the new minimum', async () => {
    await signedInAt(OLD_CLIENT);
    const keys = generateUpdateKeyPair();
    const channel = await startChannel();
    channel.serve(signManifest(manifestFor(channel.baseUrl, '2.0.0'), keys.privateKey));

    const decision = await checkForUpdate({
      currentVersion: OLD_CLIENT,
      channelBaseUrl: channel.baseUrl,
      publicKey: keys.publicKey,
    });

    expect(decision.kind).toBe('available');
    if (decision.kind !== 'available') throw new Error('unreachable');
    // The block clears only if the offered build is at least the raised minimum.
    expect(decision.manifest.releaseVersion).toBe(RAISED.minimum);
    expect(channel.requestedPaths).toEqual([`/${CHANNEL_MANIFEST_PATH}`]);
  });

  it('stays blocked rather than installing an update it cannot verify', async () => {
    const fixture = await signedInAt(OLD_CLIENT);
    const keys = generateUpdateKeyPair();
    const channel = await startChannel();
    const signed = signManifest(manifestFor(channel.baseUrl, '2.0.0'), keys.privateKey);
    channel.serve({ ...signed, manifest: { ...signed.manifest, releaseVersion: '9.9.9' } });

    await expect(
      checkForUpdate({ currentVersion: OLD_CLIENT, channelBaseUrl: channel.baseUrl, publicKey: keys.publicKey }),
    ).resolves.toEqual({ kind: 'refused', reason: 'update_signature_invalid' });

    // Being stuck is not a reason to relax the gate.
    await expect(fixture.manager.mayMutateNow()).resolves.toEqual({
      allowed: false,
      refusal: 'client_upgrade_required',
    });
  });

  it('reports the channel being unreachable as a refusal, not as "up to date"', async () => {
    const channel = await startChannel();
    await channel.close();

    await expect(
      checkForUpdate({
        currentVersion: OLD_CLIENT,
        channelBaseUrl: channel.baseUrl,
        publicKey: generateUpdateKeyPair().publicKey,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'update_offline' });
  });

  it('lets the upgraded build mutate again and asks the channel for nothing more', async () => {
    const fixture = await signedInAt(RAISED.minimum);
    const keys = generateUpdateKeyPair();
    const channel = await startChannel();
    channel.serve(signManifest(manifestFor(channel.baseUrl, '2.0.0'), keys.privateKey));

    const state = await fixture.manager.state();
    expect(state.screen).toBe('today');
    expect(state.mayMutate).toBe(true);
    await expect(fixture.manager.mayMutateNow()).resolves.toEqual({ allowed: true });

    await expect(
      checkForUpdate({
        currentVersion: RAISED.minimum,
        channelBaseUrl: channel.baseUrl,
        publicKey: keys.publicKey,
      }),
    ).resolves.toEqual({ kind: 'up_to_date' });
  });
});
