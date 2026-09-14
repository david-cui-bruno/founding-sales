import { describe, expect, it, vi } from 'vitest';
import { requestCompanyDiscovery } from '../../../../src/main/research/companyDiscoveryProvider';
const secret = 'HOSTILE-secret-key-prompt-https://private.invalid/?token=secret';
const company = { name: 'Fixture PM', domain: 'example.invalid', sourceUrl: 'https://example.invalid/' };
const input = () => ({ query: { residential: true, regions: ['Fixture'], terms: ['property management'] }, limits: { maxCompanies: 1, maxPages: 1, maxBytes: 20000, maxCostMicros: 100 }, capability: { model: 'fixture', webSearch: true as const, searchCostMicros: 50, modelCostMicros: 50 }, credentials: { apiKey: secret, model: 'fixture' }, signal: new AbortController().signal });
const envelope = () => ({ status: 'completed', model: 'fixture', output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: company.sourceUrl }] } },
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ companies: [company] }), annotations: [{ type: 'url_citation', url: company.sourceUrl }] }] },
] });
it('requests a strict candidate JSON shape in the same single bounded search call', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(envelope()));
  expect(await requestCompanyDiscovery({ ...input(), fetch })).toEqual([company]);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe('https://api.openai.com/v1/responses');
  const request = JSON.parse(String(init?.body));
  expect(request.text).toEqual({ format: {
    type: 'json_schema', name: 'company_discovery', strict: true,
    schema: { type: 'object', additionalProperties: false, required: ['companies'], properties: {
      companies: { type: 'array', maxItems: 50, items: {
        type: 'object', additionalProperties: false, required: ['name', 'domain', 'sourceUrl'],
        properties: { name: { type: 'string' }, domain: { type: 'string' }, sourceUrl: { type: 'string' } },
      } },
    } },
  } });
  expect(request).toMatchObject({ model: 'fixture', store: false, max_output_tokens: 2000, max_tool_calls: 1,
    tools: [{ type: 'web_search' }], tool_choice: 'required', include: ['web_search_call.action.sources'], input: JSON.stringify(input().query) });
  expect(request.instructions).toContain('matching the supplied schema');
  expect(request.instructions).not.toContain('{companies:');
});
it('does not fall back or retry when the provider rejects the structured request', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: secret }, { status: 400 }));
  await expect(requestCompanyDiscovery({ ...input(), fetch })).rejects.toMatchObject({ reason: 'http_rejected', httpStatus: 400 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  '```json\n{"companies":[]}\n```',
  JSON.stringify({ companies: [{ ...company, domain: 'https://example.invalid' }] }),
  JSON.stringify({ companies: [{ ...company, name: '   ' }] }),
  JSON.stringify({ companies: [{ ...company, sourceUrl: 'not a URL' }] }),
  JSON.stringify({ companies: [company], instructions: secret }),
])('still rejects invalid candidate output without salvage or another request (%#)', async text => {
  const body = envelope(); body.output[1]!.content![0]!.text = text;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
  await expect(requestCompanyDiscovery({ ...input(), fetch })).rejects.toMatchObject({ reason: 'candidate_json_invalid' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
describe('safe discovery stage diagnostics (pure provider)', () => {
  it.each(['transport_uncertain', 'response_body_invalid', 'http_rejected', 'envelope_invalid', 'search_receipt_invalid', 'output_invalid', 'candidate_json_invalid', 'citation_missing', 'consulted_source_missing'])('classifies %s without secrets or retries', async reason => {
    const body = envelope();
    if (reason === 'envelope_invalid') body.status = secret;
    if (reason === 'search_receipt_invalid') body.output[0]!.action!.type = secret;
    if (reason === 'output_invalid') body.output[1]!.role = secret;
    if (reason === 'candidate_json_invalid') body.output[1]!.content![0]!.text = secret;
    if (reason === 'citation_missing') body.output[1]!.content![0]!.annotations = [];
    if (reason === 'consulted_source_missing') body.output[0]!.action!.sources = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (reason === 'transport_uncertain') throw new Error(secret);
      if (reason === 'response_body_invalid') return new Response(secret);
      if (reason === 'http_rejected') return new Response(secret, { status: 429 });
      return Response.json(body);
    });
    const error = await requestCompanyDiscovery({ ...input(), fetch }).catch(error => error);
    expect(error).toMatchObject({ name: 'ResearchDiscoveryError', reason });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error) + error.message + error.stack).not.toContain(secret);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]?.redirect).toBe('error');
    if (reason === 'http_rejected') expect(error.httpStatus).toBe(429);
  });
  it('leaves preflight refusals unchanged and makes no call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(requestCompanyDiscovery({ ...input(), credentials: { apiKey: '', model: 'fixture' }, fetch })).rejects.toThrow('Research model unconfigured');
    await expect(requestCompanyDiscovery({ ...input(), limits: { ...input().limits, maxCostMicros: 99 }, fetch })).rejects.toThrow('Research budget exhausted');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains strict candidate validation, even for cited untrusted extra fields', async () => {
    const body = envelope(); body.output[1]!.content![0]!.text = JSON.stringify({ companies: [{ ...company, instructions: secret }] });
    await expect(requestCompanyDiscovery({ ...input(), fetch: async () => Response.json(body) })).rejects.toMatchObject({ reason: 'candidate_json_invalid' });
  });
  it('retains valid cited and consulted output', async () => {
    expect(await requestCompanyDiscovery({ ...input(), fetch: async () => Response.json(envelope()) })).toEqual([company]);
  });
});

import { ResearchDiscoveryError, researchDiscoveryDiagnostic } from '../../../../src/main/research/researchDiscoveryError';
import { ProviderError, safeError } from '../../../../src/main/outreach/providers/providerValidation';
it.each([100, 199, 300, 400, 429, 500, 599])('emits only bounded rejected HTTP status %s', status => {
  expect(researchDiscoveryDiagnostic(new ResearchDiscoveryError('http_rejected', status))).toEqual({ reason: 'http_rejected', httpStatus: status });
});
it.each([0, 99, 200, 299, 600, -1, 429.5, NaN, Infinity, '429', secret, {}, null])('drops invalid mutated HTTP status %s', status => {
  const error = new ResearchDiscoveryError('http_rejected'); Object.assign(error, { httpStatus: status });
  expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'http_rejected' });
});
it('rebuilds a safe diagnostic rather than serializing mutated error fields', () => {
  const error = new ResearchDiscoveryError('http_rejected', 429);
  Object.assign(error, { reason: secret, message: secret, stack: secret, cause: secret, url: secret, body: secret });
  expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'transport_uncertain' });
  expect(researchDiscoveryDiagnostic(new ResearchDiscoveryError('citation_missing', 429))).toEqual({ reason: 'citation_missing' });
});
it.each(['provider_response_invalid', 'network_uncertain'] as const)('distinguishes safe HTTP failure code %s without retaining error data', async code => {
  const error = new ProviderError(code); Object.assign(error, { message: secret, cause: secret });
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error);
  const result = await requestCompanyDiscovery({ ...input(), fetch }).catch(error => error);
  expect(result.reason).toBe(code === 'network_uncertain' ? 'transport_uncertain' : 'response_body_invalid');
  expect(JSON.stringify(result) + result.stack).not.toContain(secret);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('cancellation remains uncertain and never retries', async () => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
  const pending = requestCompanyDiscovery({ ...input(), signal: controller.signal, fetch });
  controller.abort(new Error(secret));
  await expect(pending).rejects.toMatchObject({ reason: 'transport_uncertain' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['declared oversize', 'stream oversize', 'empty body'])('classifies %s as invalid body', async variant => {
  const response = variant === 'empty body' ? new Response(null) : new Response(secret, variant === 'declared oversize' ? { headers: { 'content-length': '9999999' } } : undefined);
  await expect(requestCompanyDiscovery({ ...input(), limits: { ...input().limits, maxBytes: 1 }, fetch: async () => response })).rejects.toMatchObject({ reason: 'response_body_invalid' });
});
it('the existing provider timeout remains uncertain with exactly one caller request', async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const pending = requestCompanyDiscovery({ ...input(), fetch }).catch(error => error);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toMatchObject({ reason: 'transport_uncertain' });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
it.each(['no search', 'duplicate search', 'incomplete search', 'missing sources', 'duplicate message', 'empty content', 'uncorroborated citation'])('preserves refusal of %s', async defect => {
  const body = envelope();
  if (defect === 'no search') body.output.shift();
  if (defect === 'duplicate search') body.output.push(body.output[0]!);
  if (defect === 'incomplete search') body.output[0]!.status = 'incomplete';
  if (defect === 'missing sources') Object.assign(body.output[0]!.action!, { sources: undefined });
  if (defect === 'duplicate message') body.output.push(body.output[1]!);
  if (defect === 'empty content') body.output[1]!.content = [];
  if (defect === 'uncorroborated citation') body.output[0]!.action!.sources = [{ url: 'https://other.invalid/' }];
  await expect(requestCompanyDiscovery({ ...input(), fetch: async () => Response.json(body) })).rejects.toBeInstanceOf(ResearchDiscoveryError);
});
it.each([
  ['transport_uncertain', 'network_uncertain'],
  ['response_body_invalid', 'provider_response_invalid'],
] as const)('preserves the existing HTTP caller message/code for %s while adding reason metadata', async (reason, code) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (reason === 'transport_uncertain') throw new Error(secret);
    return new Response(secret);
  });
  const error = await requestCompanyDiscovery({ ...input(), fetch }).catch(error => error);
  expect(error).toMatchObject({ name: 'ResearchDiscoveryError', reason, message: code, code });
  expect(researchDiscoveryDiagnostic(error)).toEqual({ reason });
  // Desktop researchCompanies uses this exact existing normalization boundary.
  expect(safeError(error, 'provider_response_invalid').code).toBe(code);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('validates and emits the same single captured reason even with a hostile accessor', () => {
  const error = new ResearchDiscoveryError('http_rejected', 429); let reads = 0;
  Object.defineProperty(error, 'reason', { get: () => ++reads === 1 ? 'http_rejected' : secret });
  expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'http_rejected', httpStatus: 429 });
  expect(reads).toBe(1);
});

import type { OutreachProviderOptions, OutreachProviders, CompanyResearchModelProvider, StoredCredentials } from '../../../../src/main/outreach/providers/providerTypes';
it('researchCompanies consumer preserves network uncertainty without retry or credential IO', async () => {
  // Load the actual desktop consumer without expanding the worker production type graph.
  const { createOutreachProviders } = await vi.importActual<{ createOutreachProviders(options: OutreachProviderOptions): OutreachProviders & CompanyResearchModelProvider }>('../../../../src/main/outreach/providers/outreachProviders');
  const { CredentialStore } = await vi.importActual<{ CredentialStore: { prototype: { load(): Promise<StoredCredentials | null> } } }>('../../../../src/main/outreach/providers/credentialStore');
  // Constructor only binds an absolute path. Mock load before invoking the consumer.
  const load = vi.spyOn(CredentialStore.prototype, 'load').mockResolvedValue({
    model: input().credentials, gmail: { clientId: '', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0, email: '' }, senderName: '', postalAddress: '',
  });
  const forbidden = vi.fn((): never => { throw new Error('unexpected credential or browser IO'); });
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(secret));
  const manager = createOutreachProviders({ directory: '/fictional-not-accessed', safeStorage: { isEncryptionAvailable: forbidden, encryptString: forbidden, decryptString: forbidden }, openExternal: forbidden, fetch });
  try {
    const { query, limits, capability, signal } = input();
    const error = await manager.researchCompanies({ query, limits, capability }, signal).catch(error => error);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ reason: 'transport_uncertain', message: 'network_uncertain', code: 'network_uncertain' });
    expect(JSON.stringify(error) + error.stack).not.toContain(secret);
    expect(fetch).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(1); expect(forbidden).not.toHaveBeenCalled();
  } finally { manager.dispose(); load.mockRestore(); }
});

describe('bounded citation failure summary (diagnosis only)', () => {
  const summary = () => ({ candidateCount: 2, annotationCount: 1, exactMatchCount: 1, serializedMatchCount: 1, consultedMatchCount: 2 });
  it.each([
    ['missing', [], 0, 0],
    ['partial', [company.sourceUrl], 1, 1],
    ['different page', ['https://example.invalid/about'], 0, 0],
    ['root slash', ['https://example.invalid'], 0, 1],
    ['host case', ['https://EXAMPLE.invalid/'], 0, 1],
    ['default port', ['https://example.invalid:443/'], 0, 1],
    ['query differs', ['https://example.invalid/?q=1'], 0, 0],
    ['scheme differs', ['http://example.invalid/'], 0, 0],
  ] as const)('%s preserves refusal and reports candidate matches', async (_label, urls, exact, serialized) => {
    const body = envelope();
    body.output[1]!.content![0]!.text = JSON.stringify({ companies: [company, { ...company, sourceUrl: 'https://example.invalid/second' }] });
    body.output[1]!.content![0]!.annotations = urls.map(url => ({ type: 'url_citation', url }));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
    const error = await requestCompanyDiscovery({ ...input(), fetch }).catch(error => error);
    expect(error).toMatchObject({ reason: 'citation_missing', message: 'citation_missing', code: 'provider_response_invalid' });
    expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'citation_missing', citationSummary: {
      candidateCount: 2, annotationCount: urls.length, exactMatchCount: exact, serializedMatchCount: serialized, consultedMatchCount: 1,
    } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('counts candidates rather than distinct URLs, and annotations rather than distinct citations', async () => {
    const body = envelope();
    body.output[1]!.content![0]!.text = JSON.stringify({ companies: [company, company, { ...company, sourceUrl: 'https://example.invalid/other' }] });
    body.output[1]!.content![0]!.annotations.push({ type: 'url_citation', url: company.sourceUrl });
    body.output[0]!.action!.sources = [];
    const error = await requestCompanyDiscovery({ ...input(), fetch: async () => Response.json(body) }).catch(error => error);
    expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'citation_missing', citationSummary: {
      candidateCount: 3, annotationCount: 2, exactMatchCount: 2, serializedMatchCount: 2, consultedMatchCount: 0,
    } });
  });
  it('keeps empty company output valid', async () => {
    const body = envelope(); body.output[1]!.content![0]!.text = JSON.stringify({ companies: [] });
    body.output[1]!.content![0]!.annotations = []; body.output[0]!.action!.sources = [];
    expect(await requestCompanyDiscovery({ ...input(), fetch: async () => Response.json(body) })).toEqual([]);
  });
  it('copies constructor input without retaining extras or serialization hooks', () => {
    const raw = Object.assign(summary(), { private: secret, toJSON: () => secret });
    const error = new ResearchDiscoveryError('citation_missing', undefined, raw);
    raw.candidateCount = 50;
    expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'citation_missing', citationSummary: summary() });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
  it.each(['candidateCount', 'annotationCount', 'exactMatchCount', 'serializedMatchCount', 'consultedMatchCount'] as const)('rejects hostile %s as a whole at construction and emission', field => {
    for (const value of [-1, 101, NaN, Infinity, 0.5, '1', null, {}, { toJSON: () => secret }]) {
      const raw = Object.assign(summary(), { [field]: value });
      const constructed = new ResearchDiscoveryError('citation_missing', undefined, raw);
      expect(researchDiscoveryDiagnostic(constructed)).toEqual({ reason: 'citation_missing' });
      expect(JSON.stringify(constructed)).not.toContain(secret);
      const mutated = new ResearchDiscoveryError('citation_missing'); Object.assign(mutated, { citationSummary: raw });
      expect(researchDiscoveryDiagnostic(mutated)).toEqual({ reason: 'citation_missing' });
    }
    const reads = vi.fn(() => { throw new Error(secret); });
    const raw = Object.defineProperty(summary(), field, { get: reads });
    expect(researchDiscoveryDiagnostic(new ResearchDiscoveryError('citation_missing', undefined, raw))).toEqual({ reason: 'citation_missing' });
    const error = new ResearchDiscoveryError('citation_missing'); Object.assign(error, { citationSummary: raw });
    expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'citation_missing' });
    expect(reads).toHaveBeenCalledTimes(2);
  });
  it.each([
    { candidateCount: 0 }, { candidateCount: 51 }, { annotationCount: 101 }, { exactMatchCount: 2 },
    { serializedMatchCount: 0 }, { serializedMatchCount: 3 }, { consultedMatchCount: 3 },
  ])('rejects inconsistent bounds %j', patch => {
    const error = new ResearchDiscoveryError('citation_missing', undefined, Object.assign(summary(), patch));
    expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'citation_missing' });
  });
  it('captures every allowlisted summary property once and never reads extras', () => {
    const raw = {}; const reads: Record<string, number> = {};
    for (const [key, value] of Object.entries(summary())) Object.defineProperty(raw, key, { get: () => { reads[key] = (reads[key] ?? 0) + 1; return reads[key] === 1 ? value : secret; } });
    Object.defineProperty(raw, 'toJSON', { get: () => { throw new Error(secret); } });
    const error = new ResearchDiscoveryError('citation_missing'); Object.assign(error, { citationSummary: raw });
    expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'citation_missing', citationSummary: summary() });
    expect(Object.values(reads)).toEqual([1, 1, 1, 1, 1]);
  });
  it('catches hostile outer summary accessors and omits summary for unrelated reasons', () => {
    const error = new ResearchDiscoveryError('citation_missing');
    Object.defineProperty(error, 'citationSummary', { get: () => { throw new Error(secret); } });
    expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'citation_missing' });
    for (const reason of ['http_rejected', 'consulted_source_missing', 'output_invalid'] as const) {
      const other = new ResearchDiscoveryError(reason, undefined, summary());
      expect(JSON.stringify(other)).not.toContain('candidateCount');
      Object.assign(other, { citationSummary: summary() });
      expect(researchDiscoveryDiagnostic(other)).toEqual({ reason });
    }
  });
});

it.each([
  { candidateCount: 1, annotationCount: 0, exactMatchCount: 0, serializedMatchCount: 0, consultedMatchCount: 0 },
  { candidateCount: 50, annotationCount: 100, exactMatchCount: 49, serializedMatchCount: 50, consultedMatchCount: 50 },
])('accepts inclusive summary boundaries without retaining identities %j', raw => {
  const error = new ResearchDiscoveryError('citation_missing', undefined, raw);
  const diagnostic = researchDiscoveryDiagnostic(error);
  expect(diagnostic).toEqual({ reason: 'citation_missing', citationSummary: raw });
  expect(error.citationSummary).not.toBe(raw);
  expect(diagnostic.citationSummary).not.toBe(error.citationSummary);
});
it('rejects impossible zero-annotation matches both initially and after mutation', () => {
  const raw = { candidateCount: 2, annotationCount: 0, exactMatchCount: 0, serializedMatchCount: 1, consultedMatchCount: 0 };
  expect(researchDiscoveryDiagnostic(new ResearchDiscoveryError('citation_missing', undefined, raw))).toEqual({ reason: 'citation_missing' });
  const error = new ResearchDiscoveryError('citation_missing'); Object.assign(error, { citationSummary: raw });
  expect(researchDiscoveryDiagnostic(error)).toEqual({ reason: 'citation_missing' });
});
it('constructor captures allowlisted accessors once and emission ignores added hooks', () => {
  const values = { candidateCount: 1, annotationCount: 1, exactMatchCount: 0, serializedMatchCount: 1, consultedMatchCount: 1 };
  const raw = {}; const reads = vi.fn();
  for (const [key, value] of Object.entries(values)) Object.defineProperty(raw, key, { get: () => { reads(key); return value; } });
  Object.defineProperty(raw, 'private', { get: () => { throw new Error(secret); } });
  const error = new ResearchDiscoveryError('citation_missing', undefined, raw);
  expect(reads.mock.calls).toEqual(Object.keys(values).map(key => [key]));
  Object.assign(error.citationSummary!, { toJSON: () => secret, private: secret });
  const diagnostic = researchDiscoveryDiagnostic(error);
  expect(diagnostic).toEqual({ reason: 'citation_missing', citationSummary: values });
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
});
