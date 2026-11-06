import { createServer, type ServerResponse } from 'node:http';
import { context, type OutputFile } from 'esbuild';
import { fileURLToPath } from 'node:url';

type GalleryAssets = { script: OutputFile; style: OutputFile };
let assets: GalleryAssets | undefined;
let generation = 0;
const instance = globalThis.crypto.randomUUID();
const subscribers = new Set<ServerResponse>();
const firstBuild = Promise.withResolvers<void>();
const builder = await context({
  entryPoints: [fileURLToPath(new URL('../src/client/WorkspacePatternGallery.tsx', import.meta.url))],
  bundle: true, write: false, outdir: 'gallery', format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'gallery-reload', setup(build) {
    build.onEnd(result => {
      const script = result.outputFiles?.find(file => file.path.endsWith('.js'));
      const style = result.outputFiles?.find(file => file.path.endsWith('.css'));
      if (result.errors.length || !script || !style) {
        if (!assets) firstBuild.reject(new Error('Initial gallery build failed'));
        else process.stderr.write('Gallery rebuild failed; the last successful assets remain available.\n');
        return;
      }
      if (assets && Buffer.compare(assets.script.contents, script.contents) === 0 && Buffer.compare(assets.style.contents, style.contents) === 0) return;
      assets = { script, style };
      generation++;
      firstBuild.resolve();
      for (const subscriber of subscribers) subscriber.write(`data: ${instance}:${generation}\n\n`);
    });
  } }],
});
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'");
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  if (request.url === '/__gallery_changes') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    subscribers.add(response);
    response.once('close', () => { subscribers.delete(response); });
    response.write(`data: ${instance}:${generation}\n\n`);
    return;
  }
  if (request.url === '/gallery-reload.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.end("const changes=new EventSource('/__gallery_changes');changes.onmessage=event=>{if(event.data!==document.documentElement.dataset.galleryBuild)location.reload();};");
    return;
  }
  const current = assets;
  if (!current) { response.writeHead(503).end('Gallery build unavailable'); return; }
  if (request.url === '/gallery.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(current.script.contents); return; }
  if (request.url === '/gallery.css') { response.setHeader('Content-Type', 'text/css'); response.end(current.style.contents); return; }
  if (request.url !== '/') { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><html lang="en" data-gallery-build="${instance}:${generation}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Callie development patterns</title><link rel="stylesheet" href="/gallery.css"></head><body><div id="root"></div><script type="module" src="/gallery.js"></script><script type="module" src="/gallery-reload.js"></script></body></html>`);
});
let closing: Promise<void> | undefined;
const shutdown = (): Promise<void> => closing ??= (async () => {
  firstBuild.reject(new Error('Gallery stopped before readiness'));
  for (const subscriber of subscribers) subscriber.end();
  const stopped = Promise.withResolvers<void>();
  if (server.listening) server.close(error => error ? stopped.reject(error) : stopped.resolve());
  else stopped.resolve();
  server.closeAllConnections();
  await Promise.all([stopped.promise, builder.dispose()]);
})();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void shutdown().catch(() => { process.exitCode = 1; process.stderr.write('Gallery shutdown failed.\n'); });
});
try {
  await Promise.all([builder.watch(), firstBuild.promise]);
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(8879, '127.0.0.1', () => {
    server.off('error', listening.reject);
    if (!closing) process.stdout.write('Workspace pattern gallery: http://127.0.0.1:8879/ (watching)\n');
    listening.resolve();
  });
  await listening.promise;
} catch (error) {
  const interrupted = closing !== undefined;
  await shutdown();
  if (!interrupted) throw error;
}
