import assert from 'node:assert/strict';
import { test } from 'node:test';
import { founderBrowserConfiguration, socialPublisherConfiguration } from './release-founder-browser.mjs';

const baseline = { containerDefinitions: [{ environment: [], secrets: [] }] };
const metadata = {
  origin: 'https://sales.example.com', clientVersion: '1.2.3',
  founderWorkspaceId: '11111111-1111-1111-1111-111111111111',
  founderUserId: '22222222-2222-2222-2222-222222222222',
  cookieKeySecretArn: 'arn:aws:secretsmanager:us-east-1:326255650484:secret:fss-prod/browser-cookie-key-Ab12Cd',
};
const parseConfig = value => founderBrowserConfiguration(JSON.stringify(value), baseline);
const invalid = value => assert.throws(() => parseConfig(value), { message: 'founder_browser_configuration_invalid' });


test('any observed browser environment or secret prevents implicit removal', () => {
  for (const field of ['environment', 'secrets']) {
    for (const name of ['FSS_BROWSER_ORIGIN', 'FSS_BROWSER_COOKIE_KEY_HEX', 'FSS_BROWSER_FUTURE']) {
      const observed = { containerDefinitions: [{ [field]: [{ name }] }] };
      for (const absent of [undefined, '']) assert.throws(() => founderBrowserConfiguration(absent, observed), { message: 'founder_browser_configuration_required' });
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

const publisherMetadata = {
  hostAction: 'preserve', amiId: 'ami-0f11e0e04ccb60d0a',
  image: `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:${'a'.repeat(64)}`,
  runtimeReady: false,
};
const noHost = { resources: [] };

test('omitted publisher configuration cannot remove a staged host or active runtime', () => {
  const staged = { resources: [{ mode: 'managed', module: 'module.stack.module.social_publisher[0]', type: 'aws_instance', name: 'browser' }] };
  for (const raw of [undefined, '']) {
    assert.throws(() => socialPublisherConfiguration(raw, baseline, staged), { message: 'social_publisher_configuration_required' });
    for (const field of ['environment', 'secrets']) {
      for (const name of ['FSS_SOCIAL_PUBLISHER_ENDPOINT', 'FSS_SOCIAL_PUBLISHER_TOKEN', 'FSS_SOCIAL_PUBLISHER_SESSION_KEY', 'FSS_SOCIAL_PUBLISHER_CREDENTIAL_KEY', 'FSS_SOCIAL_PUBLISHER_MEDIA_ORIGIN']) {
        const running = { containerDefinitions: [{ [field]: [{ name }] }] };
        assert.throws(() => socialPublisherConfiguration(raw, running, noHost), { message: 'social_publisher_configuration_required' });
      }
    }
  }
});

test('publisher provisioning rejects credentials, partial metadata and malformed values without reflecting them', () => {
  const invalidValues = [null, [], true, {}, { ...publisherMetadata, token: 'private-input' },
    { ...publisherMetadata, amiId: 'private-input' }, { ...publisherMetadata, runtimeReady: 'true' },
    { amiId: publisherMetadata.amiId }, { runtimeReady: true },
    { ...publisherMetadata, hostAction: 'remove' }, { ...publisherMetadata, image: publisherMetadata.image.replace('@sha256:', ':') },
    { hostAction: 'retire', runtimeReady: true }, { hostAction: 'retire', runtimeReady: true, retirementAccepted: false },
    { hostAction: 'retire', runtimeReady: true, retirementAccepted: true, image: publisherMetadata.image }];
  for (const value of invalidValues) {
    assert.throws(() => socialPublisherConfiguration(JSON.stringify(value), baseline, noHost), { message: 'social_publisher_configuration_invalid' });
  }
  for (const raw of ['{private-input', 'é'.repeat(1025)]) {
    assert.throws(() => socialPublisherConfiguration(raw, baseline, noHost), { message: 'social_publisher_configuration_invalid' });
  }
});

test('unknown baseline or Terraform inventory cannot authorize implicit host removal', () => {
  for (const observed of [{}, { containerDefinitions: [] }]) {
    assert.throws(() => socialPublisherConfiguration(undefined, observed, noHost), { message: 'social_publisher_configuration_invalid' });
  }
  for (const state of [undefined, {}, { resources: null }]) {
    assert.throws(() => socialPublisherConfiguration(undefined, baseline, state), { message: 'social_publisher_configuration_invalid' });
  }
});

test('preservation pins the accepted recovery image independently of Buffer readiness', () => {
  for (const runtimeReady of [false, true]) {
    assert.deepEqual(socialPublisherConfiguration(JSON.stringify({ ...publisherMetadata, runtimeReady }), baseline, noHost), {
      social_publisher_host: { ami_id: publisherMetadata.amiId, image: publisherMetadata.image },
      social_publisher_runtime_ready: runtimeReady,
    });
  }
});

test('only explicit accepted retirement removes the recovery host while retaining Buffer configuration', () => {
  const staged = { resources: [{ mode: 'managed', module: 'module.stack.module.social_publisher[0]', type: 'aws_instance', name: 'browser' }] };
  const active = { containerDefinitions: [{ secrets: [{ name: 'FSS_SOCIAL_PUBLISHER_CREDENTIAL_KEY' }] }] };
  for (const runtimeReady of [false, true]) {
    assert.deepEqual(socialPublisherConfiguration(JSON.stringify({
      hostAction: 'retire', runtimeReady, retirementAccepted: true,
    }), active, staged), { social_publisher_host: null, social_publisher_runtime_ready: runtimeReady });
  }
  assert.throws(() => socialPublisherConfiguration('', active, staged), { message: 'social_publisher_configuration_required' });
});
