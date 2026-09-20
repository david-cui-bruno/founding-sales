import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { MAX_REQUEST_BYTES } from '../src/limits.ts';
import { createBootstrapServer } from '../src/bootstrap/server.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';

/**
 * The API container's own HTTP surface, over a real socket.
 *
 * The load balancer in `infra/modules/edge` health-checks `/healthz` and the container
 * health check in `infra/modules/cluster` calls the same path on the loopback address.
 * Both are asserted here against the server the image actually runs, because a
 * readiness path that only exists in a unit test takes a whole service out of rotation.
 */
describe('the API bootstrap server', () => {
  let database: TestDatabase;
  let origin: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    database = await createTestDatabase();
    const server = createBootstrapServer({
      session: database.session,
      expectedSystemGeneration: null,
      log: recordingLogger(),
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${String(address.port)}`;
    close = async () => new Promise<void>(resolve => server.close(() => resolve()));
  });

  afterAll(async () => {
    await close();
    await database.drop();
  });

  it('answers the health check the cluster module runs', async () => {
    const response = await fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toMatchObject({ status: 'live', component: 'api' });
  });

  it('serves readiness separately from liveness', async () => {
    const response = await fetch(`${origin}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true });
  });

  it('refuses a body larger than the limit without reading it', async () => {
    const response = await fetch(`${origin}/admin/jobs/requeue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The client sets Content-Length from the body; the server refuses on the
      // declared length, before it reads a byte.
      body: 'x'.repeat(MAX_REQUEST_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('refuses a content type that is not JSON', async () => {
    const response = await fetch(`${origin}/admin/jobs/requeue`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'jobId=1',
    });
    expect(response.status).toBe(415);
  });

  it('refuses an unmounted path with a redacted not_found', async () => {
    const response = await fetch(`${origin}/firms`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', message: 'No such endpoint.' });
  });

  it('refuses an unauthenticated admin command without saying what it wanted', async () => {
    const response = await fetch(`${origin}/admin/jobs/requeue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'x', reason: 'y' }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { message: string };
    expect(body.message).not.toContain('admin');
  });
});
