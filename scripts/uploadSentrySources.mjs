import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// CI-only. Never import this file from an application or pass its token to Docker.
const release = process.env.GITHUB_SHA;
if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main'
    || !/^[a-f0-9]{40}$/u.test(release ?? '')) throw new Error('Source upload requires an actual main-push commit');
for (const name of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT_BROWSER']) {
  if (!process.env[name]) throw new Error(`Missing source upload configuration: ${name}`);
}
for (const name of ['SENTRY_ORG', 'SENTRY_PROJECT_BROWSER']) {
  if (!/^[a-z0-9_-]+$/u.test(process.env[name])) throw new Error('Invalid source upload project');
}
if (process.argv.length !== 4) throw new Error('Missing extracted browser artifacts');
const [privateBrowser, deployedBrowser] = process.argv.slice(2).map(value => resolve(value));
const deployed = await readFile(join(deployedBrowser, 'renderer.js'));
const uploaded = await readFile(join(privateBrowser, 'renderer.js'));
if (!deployed.equals(uploaded)) throw new Error('Private browser sources do not match the published image');
const map = JSON.parse(await readFile(join(privateBrowser, 'renderer.js.map'), 'utf8'));
if (!/^[0-9a-f-]{36}$/u.test(map.debug_id ?? map.debugId ?? '')
    || !uploaded.toString().includes(map.debug_id ?? map.debugId)) throw new Error('Missing matching browser debug ID');
try {
  // No rewrite: upload the exact maps paired with the debug-ID-injected runtime bytes.
  execFileSync(resolve('node_modules/.bin/sentry-cli'), [
    'sourcemaps', 'upload', '--release', release, '--url-prefix', 'app:///',
    '--no-rewrite', '--validate', '--strict', privateBrowser,
  ], {
    stdio: 'pipe',
    env: {
      ...process.env, SENTRY_URL: 'https://us.sentry.io/', SENTRY_PROJECT: process.env.SENTRY_PROJECT_BROWSER,
      SENTRY_LOG_LEVEL: 'error', SENTRY_DISABLE_UPDATE_CHECK: '1',
    },
  });
} catch { throw new Error('Private Sentry browser artifact upload failed'); }
