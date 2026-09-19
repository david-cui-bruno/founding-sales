import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkerEndpoint, WORKER_ENDPOINT_FILE, workerEndpointSchema } from './workerEndpoint';

let directory: string;
beforeEach(async () => { directory = join(await mkdtemp(join(tmpdir(), 'client-endpoint-')), 'client'); });
afterEach(async () => { await rm(join(directory, '..'), { recursive: true, force: true }); });

const writeEndpointFile = (value: unknown) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, WORKER_ENDPOINT_FILE), typeof value === 'string' ? value : JSON.stringify(value));
};

describe('workerEndpointSchema', () => {
  it('accepts an https origin and normalises a trailing slash away', () => {
    expect(workerEndpointSchema.parse('https://z.example.test/')).toBe('https://z.example.test');
    expect(workerEndpointSchema.parse(' https://z.example.test ')).toBe('https://z.example.test');
  });
  it('accepts plain http only on the loopback interface', () => {
    expect(workerEndpointSchema.parse('http://127.0.0.1:4321')).toBe('http://127.0.0.1:4321');
    expect(workerEndpointSchema.parse('http://localhost:4321/')).toBe('http://localhost:4321');
    expect(workerEndpointSchema.safeParse('http://worker.example.test').success).toBe(false);
  });
  it('refuses credentials, a path, a query or a fragment', () => {
    for (const value of ['https://u:p@z.example.test', 'https://z.example.test/v1', 'https://z.example.test/?x=1', 'https://z.example.test/#x', 'ftp://z.example.test', 'not a url']) {
      expect(workerEndpointSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('resolveWorkerEndpoint', () => {
  it('takes the environment override only when the app is not packaged', () => {
    const env = { CALLIE_WORKER_ENDPOINT: 'http://127.0.0.1:5000/' };
    expect(resolveWorkerEndpoint({ env, clientDirectory: directory, isPackaged: false })).toEqual({ endpoint: 'http://127.0.0.1:5000', source: 'environment' });
    expect(resolveWorkerEndpoint({ env, clientDirectory: directory, isPackaged: true })).toEqual({ endpoint: null, source: 'none', problem: 'unconfigured' });
  });

  it('reads the public endpoint file under the client directory', () => {
    writeEndpointFile({ endpoint: 'https://z.example.test/' });
    expect(resolveWorkerEndpoint({ env: {}, clientDirectory: directory, isPackaged: true })).toEqual({ endpoint: 'https://z.example.test', source: 'file' });
  });

  it('reports an invalid environment value or file honestly', () => {
    expect(resolveWorkerEndpoint({ env: { CALLIE_WORKER_ENDPOINT: 'http://worker.example.test' }, clientDirectory: directory, isPackaged: false })).toEqual({ endpoint: null, source: 'none', problem: 'invalid' });
    writeEndpointFile('{ not json');
    expect(resolveWorkerEndpoint({ env: {}, clientDirectory: directory, isPackaged: true })).toEqual({ endpoint: null, source: 'none', problem: 'invalid' });
    writeEndpointFile({ endpoint: 'https://z.example.test/v1' });
    expect(resolveWorkerEndpoint({ env: {}, clientDirectory: directory, isPackaged: true })).toEqual({ endpoint: null, source: 'none', problem: 'invalid' });
  });

  it('is unconfigured when neither the environment nor the file names a worker', () => {
    expect(resolveWorkerEndpoint({ env: {}, clientDirectory: directory, isPackaged: false })).toEqual({ endpoint: null, source: 'none', problem: 'unconfigured' });
  });
});
