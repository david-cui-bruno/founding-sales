import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { founderBrowserConfiguration } from './release-founder-browser.mjs';

const baseline = { containerDefinitions: [{ environment: [], secrets: [] }] };
const metadata = {
  origin: 'https://sales.example.com', clientVersion: '1.2.3',
  founderWorkspaceId: '11111111-1111-1111-1111-111111111111',
  founderUserId: '22222222-2222-2222-2222-222222222222',
  cookieKeySecretArn: 'arn:aws:secretsmanager:us-east-1:326255650484:secret:fss-prod/browser-cookie-key-Ab12Cd',
};
const parseConfig = value => founderBrowserConfiguration(JSON.stringify(value), baseline);
const invalid = value => assert.throws(() => parseConfig(value), { message: 'founder_browser_configuration_invalid' });

test('missing config preserves disabled baseline and enabled metadata passes exactly', () => {
  assert.equal(founderBrowserConfiguration(undefined, baseline), null);
  assert.equal(founderBrowserConfiguration('', baseline), null);
  assert.deepEqual(parseConfig(metadata), metadata);
  const certificate = { ...metadata, certificateArn: 'arn:aws:acm:us-east-1:326255650484:certificate/33333333-3333-3333-3333-333333333333' };
  assert.deepEqual(parseConfig(certificate), certificate);
});

test('any observed browser environment or secret prevents implicit removal', () => {
  for (const field of ['environment', 'secrets']) {
    for (const name of ['FSS_BROWSER_ORIGIN', 'FSS_BROWSER_COOKIE_KEY_HEX', 'FSS_BROWSER_FUTURE']) {
      const observed = { containerDefinitions: [{ [field]: [{ name }] }] };
      for (const absent of [undefined, '']) assert.throws(() => founderBrowserConfiguration(absent, observed), { message: 'founder_browser_configuration_required' });
      assert.deepEqual(founderBrowserConfiguration(JSON.stringify(metadata), observed), metadata);
    }
  }
  assert.throws(() => founderBrowserConfiguration(undefined, {}), { message: 'founder_browser_configuration_invalid' });
});

test('malformed, partial, unknown and value-bearing inputs fail without reflecting values', () => {
  for (const value of [null, [], true, 'private-input', {}, { ...metadata, cookieKeyHex: 'private-input' }]) invalid(value);
  for (const key of Object.keys(metadata)) {
    const partial = { ...metadata }; delete partial[key]; invalid(partial);
    invalid({ ...metadata, [key]: null });
  }
  for (const raw of ['{private-input', ' '.repeat(4097), 'é'.repeat(2049)]) {
    assert.throws(() => founderBrowserConfiguration(raw, baseline), { message: 'founder_browser_configuration_invalid' });
  }
});

test('every metadata field is strictly validated', () => {
  const rejected = {
    origin: ['http://sales.example.com', 'https://sales.example.com/', 'https://USER:private@sales.example.com', 'https://SALES.example.com', 'https://sales.example.com:443', 'https://sales.example.com/path', 'https://sales.example.com?x=private', 'https://sales..example.com', 'https://sales.example.com#private'],
    clientVersion: ['1.2', '01.2.3', '1.2.3-private'],
    founderWorkspaceId: ['private', 'AAAAAAAA-1111-1111-1111-111111111111'],
    founderUserId: ['private', '22222222222222222222222222222222'],
    cookieKeySecretArn: ['private-input', metadata.cookieKeySecretArn.replace('us-east-1', 'us-west-2'), metadata.cookieKeySecretArn.replace('326255650484', '123456789012'), metadata.cookieKeySecretArn.replace('browser-cookie-key', 'other'), `${metadata.cookieKeySecretArn}:key::`],
    certificateArn: [null, '', 'private-input', 'arn:aws:acm:us-west-2:326255650484:certificate/33333333-3333-3333-3333-333333333333', 'arn:aws:acm:us-east-1:123456789012:certificate/33333333-3333-3333-3333-333333333333'],
  };
  for (const [key, values] of Object.entries(rejected)) for (const value of values) invalid({ ...metadata, [key]: value });
});

test('workflow binds metadata only to prepare and saved-plan assembly consumes validated value', () => {
  const workflowText = readFileSync('.github/workflows/greenfield-deploy.yml', 'utf8');
  const plan = workflowText.split('\n  review-prepare:')[1]?.split('\n  reviewed:')[0];
  assert.ok(plan);
  assert.match(plan, /environment: production-plan/u);
  assert.ok(plan.includes('- name: Save the exact plan and encrypt it for the protected application job\n        env:\n          FSS_PRODUCTION_FOUNDER_BROWSER_JSON: ${{ vars.FSS_PRODUCTION_FOUNDER_BROWSER_JSON }}\n        run: |\n          set -euo pipefail\n          node infra/scripts/reviewed-release.mjs prepare'));
  assert.equal(workflowText.match(/FSS_PRODUCTION_FOUNDER_BROWSER_JSON/gu).length, 2);
  const source = readFileSync('infra/scripts/reviewed-release.mjs', 'utf8');
  assert.match(source, /baselineApi\?\.taskDefinitionArn !== baseline.bindings.apiTaskDefinition/u);
  assert.match(source, /founderBrowserConfiguration\(process.env.FSS_PRODUCTION_FOUNDER_BROWSER_JSON, baselineApi\)/u);
  assert.match(source, /const variables = \{ founder_browser: founderBrowser,/u);
  assert.match(source, /writeFileSync\(variableFile, JSON.stringify\(variables\), \{ mode: 0o600 \}\)/u);
  assert.doesNotMatch(source.slice(source.indexOf("} else if (mode === 'execute')")), /FSS_PRODUCTION_FOUNDER_BROWSER_JSON/u);
});
