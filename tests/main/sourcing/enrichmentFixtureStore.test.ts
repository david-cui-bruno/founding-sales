import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFileSystemEnrichmentRequestStore } from '../../../src/main/sourcing/enrichmentFixtureStore';
import { createProductionEnrichmentRequester } from '../../../src/main/startApplication';
import type { EnrichmentCandidate } from '../../../src/main/domain/founderSalesDomain';
import type { FoundationRuntime } from '../../../src/main/foundation/foundationRuntime';
import { enrichmentRequestSchema } from '../../../src/shared/contracts/enrichmentRequestContract';

const credentials = vi.hoisted(() => ({ constructed: vi.fn(), load: vi.fn() }));
vi.mock('electron', () => ({ safeStorage: {}, dialog: {}, shell: {} }));
vi.mock('../../../src/main/sourcing/sourcingCredentialStore', () => ({
  SourcingCredentialStore: class {
    constructor() { credentials.constructed(); }
    load = credentials.load;
  },
}));

const KEY = 'upstream/enrichment-requests/2026-09-08-01JC0000000000000000000000.ndjson';
const BODY = `${JSON.stringify({ cloud_entity_id: 'ce_01JC0000000000000000000000',
  requested_at: '2026-09-08T12:00:00.000Z', owner_full_name: 'Fixture Owner',
  situs_address: { line1: '123 Fixture St', locality: 'Providence', region: 'RI', postal_code: null } })}\n`;
const input = (key = KEY, signal = new AbortController().signal) => ({
  key, body: BODY, contentType: 'application/x-ndjson', signal,
});
let directory: string;
let root: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'callie-enrichment-store-test-'));
  root = join(directory, 'inbox');
  mkdirSync(root, { mode: 0o700 });
  vi.clearAllMocks();
  credentials.load.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe('fixture-only enrichment request store', () => {
  it('persists the exact request under the allowed prefix with private permissions', async () => {
    await createFileSystemEnrichmentRequestStore(root).putObjectText(input());
    expect(readFileSync(join(root, KEY), 'utf8')).toBe(BODY);
    expect(statSync(join(root, KEY)).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(['upstream']);
    expect(readdirSync(join(root, 'upstream'))).toEqual(['enrichment-requests']);
    expect(statSync(join(root, 'upstream/enrichment-requests')).mode & 0o777).toBe(0o700);
  });

  it.each([
    'events/2026-09-08/request.ndjson',
    'upstream/membership/2026-09-08.json',
    `../${KEY}`, `/${KEY}`, KEY.replace('upstream/', 'upstream/../'),
    KEY.replace('enrichment-requests/', 'enrichment-requests/nested/'),
    KEY.replace('enrichment-requests/', 'enrichment-requests//'),
    KEY.replace('/', '\\'), `${KEY}\n`, `${KEY}.extra`,
    KEY.replace('01JC', '01IC'), KEY.replace('2026-09-08', '2026-9-8'),
    KEY.replace('01JC', '%2fC'), 'upstream/enrichment-requests/' + 'x'.repeat(4096),
  ])('rejects non-generated or escaping key %s before creating directories', async key => {
    await expect(createFileSystemEnrichmentRequestStore(root).putObjectText(input(key))).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses invalid content type and bounds the fixture payload', async () => {
    const store = createFileSystemEnrichmentRequestStore(root);
    await expect(store.putObjectText({ ...input(), contentType: 'text/plain' })).rejects.toThrow();
    await expect(store.putObjectText({ ...input(), body: 'x'.repeat(64 * 1024 + 1) })).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  it('aborts before any filesystem writes and does not poison a later request', async () => {
    const store = createFileSystemEnrichmentRequestStore(root);
    const controller = new AbortController();
    controller.abort(new Error('fixture request cancelled'));
    await expect(store.putObjectText(input(KEY, controller.signal))).rejects.toThrow('fixture request cancelled');
    expect(readdirSync(root)).toEqual([]);
    await store.putObjectText(input());
    expect(readFileSync(join(root, KEY), 'utf8')).toBe(BODY);
  });

  it('exclusively creates a request and never overwrites an existing file', async () => {
    const store = createFileSystemEnrichmentRequestStore(root);
    const results = await Promise.allSettled([store.putObjectText(input()), store.putObjectText(input())]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    await expect(store.putObjectText({ ...input(), body: 'replacement\n' })).rejects.toThrow();
    expect(readFileSync(join(root, KEY), 'utf8')).toBe(BODY);
  });

  it.each(['', 'relative/inbox'])('rejects non-absolute fixture root %s', async badRoot => {
    await expect(async () => createFileSystemEnrichmentRequestStore(badRoot).putObjectText(input())).rejects.toThrow();
  });

  it('requires an existing directory root rather than creating arbitrary roots', async () => {
    const missing = join(directory, 'missing');
    const file = join(directory, 'file');
    writeFileSync(file, 'sentinel');
    for (const badRoot of [missing, file]) {
      await expect(async () => createFileSystemEnrichmentRequestStore(badRoot).putObjectText(input())).rejects.toThrow();
    }
    expect(readdirSync(directory).sort()).toEqual(['file', 'inbox']);
  });

  it.each(['', '/'])('refuses an existing symlink root even with trailing slash %s', async suffix => {
    const link = join(directory, 'linked-root');
    symlinkSync(root, link, 'dir');
    await expect(async () => createFileSystemEnrichmentRequestStore(link + suffix).putObjectText(input())).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(['upstream', 'upstream/enrichment-requests'])('refuses symlink directory %s without escaping', async component => {
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    if (component.includes('/')) mkdirSync(join(root, 'upstream'));
    symlinkSync(outside, join(root, component), 'dir');
    await expect(createFileSystemEnrichmentRequestStore(root).putObjectText(input())).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses an existing destination symlink without touching its target', async () => {
    mkdirSync(join(root, 'upstream/enrichment-requests'), { recursive: true });
    const target = join(directory, 'outside.ndjson');
    writeFileSync(target, 'sentinel');
    symlinkSync(target, join(root, KEY));
    await expect(createFileSystemEnrichmentRequestStore(root).putObjectText(input())).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('sentinel');
  });

  it('rechecks the root on each request instead of trusting a cached resolved path', async () => {
    const store = createFileSystemEnrichmentRequestStore(root);
    await store.putObjectText(input());
    renameSync(root, join(directory, 'previous-inbox'));
    mkdirSync(join(directory, 'outside'));
    symlinkSync(join(directory, 'outside'), root, 'dir');
    await expect(store.putObjectText(input(KEY.replace('0000.ndjson', '0001.ndjson')))).rejects.toThrow();
    expect(readdirSync(join(directory, 'outside'))).toEqual([]);
  });
});

describe('production enrichment factory fixture branch', () => {
  function candidate(): EnrichmentCandidate {
    return { cloudEntityId: 'ce_01JC0000000000000000000000', ownerFullName: 'Fixture Owner',
      situsAddress: { line1: '123 Fixture St', locality: 'Providence', region: 'RI', postalCode: null },
      lastRequestedAt: null, qualificationState: 'eligible', fitBand: 'medium',
      identityReady: true, hasUsableDirectContact: false, suppressionBlocked: false };
  }
  function requester(value = candidate()) {
    const domain = { getEnrichmentRequestCandidate: vi.fn(() => value), recordEnrichmentRequested: vi.fn() };
    const runtime = { withDomain: async <T,>(operation: (value: typeof domain) => T) => operation(domain) } as unknown as FoundationRuntime;
    return { domain, requester: createProductionEnrichmentRequester(runtime, join(directory, 'unused-profile')) };
  }

  it('uses the real writer and ledger while never constructing or loading host credentials', async () => {
    vi.stubEnv('CALLIE_SOURCING_FIXTURE_DIR', root);
    const { requester: service, domain } = requester();
    await expect(service.request({ personId: 'fixture-person' })).resolves.toEqual({ written: true, refusalReason: null });
    const files = readdirSync(join(root, 'upstream/enrichment-requests'));
    expect(files).toHaveLength(1);
    const line = readFileSync(join(root, 'upstream/enrichment-requests', files[0]!), 'utf8');
    expect(line.split('\n')).toHaveLength(2);
    expect(enrichmentRequestSchema.parse(JSON.parse(line))).toMatchObject({
      cloud_entity_id: candidate().cloudEntityId, owner_full_name: candidate().ownerFullName,
      situs_address: { line1: '123 Fixture St', locality: 'Providence', region: 'RI', postal_code: null },
    });
    expect(domain.getEnrichmentRequestCandidate).toHaveBeenCalledTimes(2);
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledTimes(1);
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledWith({ cloudEntityId: candidate().cloudEntityId });
    expect(credentials.constructed).not.toHaveBeenCalled();
    expect(credentials.load).not.toHaveBeenCalled();
  });

  it('does not bypass domain qualification or create a fake successful receipt', async () => {
    vi.stubEnv('CALLIE_SOURCING_FIXTURE_DIR', root);
    const { requester: service, domain } = requester({ ...candidate(), qualificationState: 'unreviewed' });
    await expect(service.request({ personId: 'fixture-person' })).resolves.toEqual({ written: false, refusalReason: 'qualification_required' });
    expect(readdirSync(root)).toEqual([]);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
    expect(credentials.load).not.toHaveBeenCalled();
  });

  it('does not fall back to host credentials or record success when fixture storage is invalid', async () => {
    vi.stubEnv('CALLIE_SOURCING_FIXTURE_DIR', '');
    const { requester: service, domain } = requester();
    await expect(service.request({ personId: 'fixture-person' })).rejects.toThrow();
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
    expect(credentials.constructed).not.toHaveBeenCalled();
    expect(credentials.load).not.toHaveBeenCalled();
  });

  it('retains the production credential gate when the fixture variable is absent', async () => {
    vi.stubEnv('CALLIE_SOURCING_FIXTURE_DIR', undefined);
    const { requester: service, domain } = requester();
    await expect(service.request({ personId: 'fixture-person' })).resolves.toEqual({ written: false, refusalReason: 'credentials_unavailable' });
    expect(credentials.constructed).toHaveBeenCalledTimes(1);
    expect(credentials.load).toHaveBeenCalledTimes(1);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });
});
