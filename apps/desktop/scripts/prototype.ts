import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compileStylesheet } from './styles.ts';

/**
 * The Slice 1 design prototype's development server.
 *
 * `npm run prototype --workspace apps/desktop` → http://127.0.0.1:5199/
 *
 * It bundles `src/prototype/main.tsx` and compiles `src/prototype/prototype.css` the way
 * `scripts/bundle.ts` compiles the shipped renderer, on every request so an edit shows on
 * reload. It listens on loopback only and serves exactly three paths. Nothing here is in
 * `BUNDLE_WINDOWS` or the packaged tree, and the page has no bridge and no network.
 */

const root = fileURLToPath(new URL('../src/prototype/', import.meta.url));

async function script(): Promise<string> {
  const result = await build({
    entryPoints: [`${root}main.tsx`],
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2023',
    format: 'esm',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    sourcemap: 'inline',
    logLevel: 'silent',
  });
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error('esbuild produced no output');
  return output.text;
}

export async function startPrototypeServer(port = 0): Promise<{ readonly url: string; stop(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split(/[?#]/u)[0];
    const send = async (): Promise<void> => {
      if (path === '/' || path === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(await readFile(`${root}index.html`, 'utf8'));
      } else if (path === '/prototype.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(await script());
      } else if (path === '/prototype.css') {
        response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
        response.end(await compileStylesheet(`${root}prototype.css`));
      } else {
        response.writeHead(404).end();
      }
    };
    send().catch((error: unknown) => {
      console.error(error);
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(bound)}/`,
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env['PROTOTYPE_PORT'] ?? 5199);
  const { url } = await startPrototypeServer(port);
  console.error(`Callie design prototype: ${url}`);
}
