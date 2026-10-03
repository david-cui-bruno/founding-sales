import { afterEach, describe, expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createDesktopFixture, type DesktopFixture } from './support/desktopFixture.ts';

/**
 * Lane M1, review M1F finding 4: the API's minimum moved to 1.0.36 while a 1.0.35 Mac held a
 * session. Its reads are answered in the shape it parses (the API's `meetingCompat.ts`); its
 * first command is refused with 426, and that refusal takes the running session to
 * "Update now", as an open refused for the version would. Nothing is wiped.
 */

let fixture: DesktopFixture | null = null;
afterEach(async () => {
  await fixture?.stop();
  fixture = null;
});

describe('a command refused for the version (426)', () => {
  it('reaches the session manager, which shows the update screen without wiping anything', async () => {
    fixture = await createDesktopFixture({ clientVersion: '1.0.35', supported: { minimum: '1.0.14', maximum: '1.999.999' } });
    const f = fixture;
    f.script.browserFinished(true);
    await f.manager.signIn({ workspaceId: f.workspaceId, deviceLabel: 'Review' });
    expect((await f.manager.state()).screen).toBe('today');
    const refusals: number[] = [];
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test',
      clientVersion: '1.0.35',
      accessToken: async () => await f.manager.accessToken(),
      onAuthRefusal: (reason, status, generation) => {
        refusals.push(status);
        void f.manager.noteAuthRefusal(reason, generation);
      },
      send: async () => await Promise.resolve({ status: 426, body: { status: 'refused', reason: 'client_upgrade_required' } }),
    });
    expect(await api.command('/opportunities/stage', {}, () => null)).toMatchObject({ ok: false, reason: 'client_upgrade_required' });
    expect(refusals).toEqual([426]);
    const state = await f.manager.state();
    expect(state.screen).toBe('upgrade_required');
    expect(state.mayMutate).toBe(false);
    // Still signed in: the registration and its secret are kept.
    expect(f.vault.entries.size).toBeGreaterThan(0);
  });
});
