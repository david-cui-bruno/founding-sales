import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOperatorPairing } from '../src/operatorPairing';
import { connectOperatorAws } from '../src/operatorPairingAws';

const wire = vi.hoisted(() => ({ requests: [] as Array<{ hostname: string; headers: Record<string, string>; body?: unknown }> }));
// Keep the actual pinned SDK serializers, credential middleware and signer.
// Replace ONLY transport at client construction. No socket-capable handler exists.
vi.mock('@aws-sdk/client-sts', async importOriginal => {
  const sdk = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return { ...sdk, STSClient: class extends sdk.STSClient {
    constructor(config: ConstructorParameters<typeof sdk.STSClient>[0]) {
      super({ ...config, requestHandler: { handle: async (request: { hostname: string; headers: Record<string, string>; body?: unknown }) => {
        wire.requests.push(request);
        return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: new TextEncoder().encode(
          '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/operator</Arn><UserId>fictional</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>fictional</RequestId></ResponseMetadata></GetCallerIdentityResponse>') } };
      } } });
    }
  } };
});
vi.mock('@aws-sdk/client-dynamodb', async importOriginal => {
  const sdk = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  return { ...sdk, DynamoDBClient: class extends sdk.DynamoDBClient {
    constructor(config: ConstructorParameters<typeof sdk.DynamoDBClient>[0]) {
      super({ ...config, requestHandler: { handle: async (request: { hostname: string; headers: Record<string, string>; body?: unknown }) => {
        wire.requests.push(request);
        const body = request.headers['x-amz-target']?.endsWith('DescribeTable')
          ? { Table: { TableName: 'worker-table', TableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/worker-table', TableStatus: 'ACTIVE' } } : {};
        return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.0' }, body: new TextEncoder().encode(JSON.stringify(body)) } };
      } } });
    }
  } };
});
beforeEach(() => {
  wire.requests.length = 0;
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'FICTIONAL_ACCESS_KEY');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fictional-signing-secret-for-offline-tests');
  vi.stubEnv('AWS_SESSION_TOKEN', 'fictional-session-token');
  vi.stubEnv('AWS_ENDPOINT_URL_STS', 'https://untrusted.invalid');
  vi.stubEnv('AWS_ENDPOINT_URL', 'https://untrusted.invalid');
});
afterEach(() => vi.unstubAllEnvs());

describe('actual pinned SDK operator signing', () => {
  it('signs identity, table preflight and one bootstrap transaction using the captured identity', async () => {
    const save = vi.fn(async (_code: string) => { void _code; });
    const close = vi.fn(async () => {});
    const response = await runOperatorPairing(['--account', '123456789012', '--region', 'us-east-1',
      '--table', 'worker-table', '--workspace', 'workspace-one', '--expires', '60', '--scopes', 'events:read',
      '--output', '/fictional/code', '--execute'], { reserveOutput: async () => ({ save, close }), connect: connectOperatorAws });
    expect(response).toMatchObject({ exitCode: 0 });
    expect(wire.requests.map(request => request.hostname)).toEqual([
      'sts.us-east-1.amazonaws.com', 'dynamodb.us-east-1.amazonaws.com', 'dynamodb.us-east-1.amazonaws.com',
    ]);
    for (const request of wire.requests) {
      expect(request.headers.authorization).toContain('Credential=FICTIONAL_ACCESS_KEY/');
      expect(request.headers['x-amz-security-token']).toBe('fictional-session-token');
      expect(request.headers.authorization).toContain('Signature=');
    }
    expect(save).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    const code = save.mock.calls[0]![0];
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(wire.requests)).not.toContain(code);
    expect(JSON.stringify(response)).not.toContain(code);
    expect(wire.requests[2]!.headers['x-amz-target']).toContain('TransactWriteItems');
  });
});
