import { request, type Server } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { localCertificate } from './tls.ts';

/** Fixture ALB: TLS termination only. Original Host is preserved, never synthesized
 * from forwarded headers. Product routing and authentication stay in the API. */
export async function founderHostProxy(api: Server, certificate: Awaited<ReturnType<typeof localCertificate>>, port: number) {
  const upstream = api.address() as AddressInfo;
  const proxy = createServer(certificate, (incoming, outgoing) => {
    const forwarded = request({ hostname: '127.0.0.1', port: upstream.port,
      method: incoming.method, path: incoming.url, headers: incoming.rawHeaders, agent: false }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    forwarded.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on('aborted', () => forwarded.destroy());
    incoming.pipe(forwarded);
  });
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(port, 'localhost', resolve); });
  return proxy;
}
