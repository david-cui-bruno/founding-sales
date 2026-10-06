import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('wires the social bucket into the API independently of the optional upgrade URL', () => {
  // Route tests inject a media store. This checks the deployment boundary that
  // otherwise silently leaves those same routes unavailable in production.
  const stack = readFileSync(new URL('../../../infra/modules/stack/main.tf', import.meta.url), 'utf8');
  const apiEnvironment = stack.split('api_environment =')[1]?.split('worker_environment =')[0];
  expect(apiEnvironment).toMatch(/merge\(\s*\{\s*FSS_SOCIAL_ASSETS_BUCKET\s*=\s*module\.social_assets\.bucket_name\s*\},/u);
});
