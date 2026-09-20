import { connect, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { clientVersionRangeSchema } from '@fss/contracts';
import { MAX_REQUEST_BYTES } from '../src/limits.ts';
import { createApiServer } from '../src/server.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';

/**
 * The API's HTTP surface, over a real socket.
 *
 * The load balancer in `infra/modules/edge` health-checks `/healthz` and the container
 * health check in `infra/modules/cluster` calls the same path on the loopback address.
 * Both are asserted here against the server the image actually runs, because a
 * readiness path that only exists in a unit test takes a whole service out of rotation.
 *
 * Until lane G3b this exercised a second server — `bootstrap/server.ts` — that existed
 * because `server.ts` belonged to the identity lane. There is one server now, and it
 * is the one `Dockerfile.api` runs, so these assertions are about the real thing
 * rather than about its twin.
 */
describe('the API server over a socket', () => {
  let database: TestDatabase;
  let origin: string;
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    database = await createTestDatabase();
    const server = createApiServer({
      session: database.session,
      expectedSystemGeneration: null,
      supportedClientVersions: clientVersionRangeSchema.parse({ minimum: '1.0.0', maximum: '1.0.0' }),
      sendingEnabled: false,
      log: recordingLogger(),
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    port = address.port;
    origin = `http://127.0.0.1:${String(port)}`;
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
    // A raw socket, because the refusal happens *before* the body: the request line
    // and the headers are sent, not one byte of the megabyte they promise, and the
    // 413 comes back anyway. A fetch client would still be writing when it arrived.
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          [
            'POST /admin/jobs/requeue HTTP/1.1',
            `Host: 127.0.0.1:${String(port)}`,
            'Content-Type: application/json',
            `Content-Length: ${String(MAX_REQUEST_BYTES + 1)}`,
            '',
            '',
          ].join('\r\n'),
        );
      });
      socket.setEncoding('utf8');
      socket.once('data', chunk => {
        socket.destroy();
        resolve(String(chunk));
      });
      socket.once('error', reject);
    });
    expect(status).toContain('HTTP/1.1 413');
    expect(status).toContain('payload_too_large');
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
