import { createServer } from 'node:http';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const output = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/WorkspacePatternGallery.tsx', import.meta.url))],
  bundle: true, write: false, outdir: 'gallery', format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const script = output.outputFiles.find(file => file.path.endsWith('.js'));
const style = output.outputFiles.find(file => file.path.endsWith('.css'));
if (!script || !style) throw new Error('Gallery assets missing');
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'");
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  if (request.url === '/gallery.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script.contents); return; }
  if (request.url === '/gallery.css') { response.setHeader('Content-Type', 'text/css'); response.end(style.contents); return; }
  if (request.url !== '/') { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Callie development patterns</title><link rel="stylesheet" href="/gallery.css"></head><body><div id="root"></div><script type="module" src="/gallery.js"></script></body></html>');
});
server.listen(8879, '127.0.0.1', () => { process.stdout.write('Workspace pattern gallery: http://127.0.0.1:8879/\n'); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.closeAllConnections(); server.close(); });
