import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createNotificationApiPort } from '../src/main/notifications/api.ts';

it('checks current Today authority after a replayed acknowledgement instead of trusting the cached command target', async () => {
  const target = { kind: 'meeting', firmId: randomUUID(), meetingId: randomUUID(), startsAt: '2026-09-15T03:30:00.000Z' };
  const paths: string[] = [];
  const api = createAuthedClient({ baseUrl: 'https://callie.example.test', clientVersion: '1.4.0', accessToken: async () => ({ token: 'controlled-session', generation: 1 }),
    async send(url) { const path = new URL(url).pathname; paths.push(path); return path === '/notifications/acknowledge' ? { status: 200, body: { status: 'accepted', replayed: true, result: { version: 1, target } } } : { status: 200, body: { version: 1, target: null } }; },
  });
  expect(await createNotificationApiPort(api, () => true).acknowledge(randomUUID(), `meeting:${target.meetingId}`)).toEqual({ ok: true, value: null });
  expect(paths).toEqual(['/notifications/acknowledge', '/today/actions/open']);
});
