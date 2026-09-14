import { describe, expect, it, vi } from 'vitest';
import { requestGuidedCompanyDiscovery, validateGuidedDiscoverySources } from '../../../../src/main/research/guidedCompanyDiscoveryProvider';
import { ResearchDiscoveryError } from '../../../../src/main/research/researchDiscoveryError';

const root = 'https://example.com/';
const url = 'https://example.com/about';
const marker = '\uE200cite\uE202turn0search0\uE201';
const text = (record: unknown = { name: 'Élan 物業 🏘', domain: 'example.com' }) =>
  '```json\n' + JSON.stringify(record) + '\n```\nSource for selected company. ' + marker;
function reply() {
  return { status: 'completed', model: 'test-model', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url }, { type: 'feed', name: 'not a URL' }] } },
    { type: 'message', role: 'assistant', status: 'completed', content: [
      { type: 'output_text', text: text(), annotations: [{ type: 'url_citation', url }] },
    ] },
  ] };
}
type Reply = ReturnType<typeof reply>;
function content(r: Reply) { return r.output[1]!.content![0]!; }
function input(fetch: typeof globalThis.fetch = vi.fn(async () => Response.json(reply()))) {
  return { query: { residential: true, regions: ['CA'], terms: ['residential PM'] },
    limits: { maxCompanies: 1, maxPages: 1, maxBytes: 100000, maxCostMicros: 10 },
    capability: { model: 'test-model', webSearch: true as const, searchCostMicros: 2, modelCostMicros: 3 },
    credentials: { apiKey: 'secret-token', model: 'test-model' }, signal: new AbortController().signal,
    permittedSources: Object.freeze([root, 'https://example.com/deep']), fetch };
}
async function rejectsReply(value: unknown, reason: string) {
  const fetch = vi.fn(async () => Response.json(value));
  await expect(requestGuidedCompanyDiscovery(input(fetch))).rejects.toMatchObject({ reason });
  expect(fetch).toHaveBeenCalledTimes(1);
}

describe('guided source preflight', () => {
  it('extracts only exact approved HTTPS roots, deduplicates/sorts without mutation', () => {
    const sources = Object.freeze(['https://zebra.com/', root, root, 'https://example.com/deep',
      'https://EXAMPLE.com/', 'https://example.com', 'https://example.com:443/', 'https://example.com/?x=1',
      'https://example.com/#x', 'https://user@example.com/', 'http://example.com/', 'https://127.0.0.1/',
      'https://x.local/', 'https://narpm.org/', 'https://linkedin.com/', 'https://example.com./']);
    expect(validateGuidedDiscoverySources(sources)).toEqual(['example.com', 'zebra.com']);
    expect(sources[0]).toBe('https://zebra.com/');
  });
  it.each([
    { sources: [] }, { sources: ['https://example.com/deep'] }, { sources: ['https://example.com'] },
    { sources: ['https://narpm.org/'] }, { sources: ['https://linkedin.com/'] }, { sources: ['https://192.168.0.1/'] },
    { sources: Array.from({ length: 101 }, (_, i) => `https://host${i}.com/`) },
  ])('rejects no roots or over 100 before IO: $sources', async ({ sources }) => {
    const fetch = vi.fn();
    await expect(requestGuidedCompanyDiscovery({ ...input(fetch), permittedSources: sources })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('allows 100 unique roots and duplicates do not consume the cap', () => {
    const sources = Array.from({ length: 100 }, (_, i) => `https://host${i}.com/`);
    expect(validateGuidedDiscoverySources([...sources, ...sources])).toHaveLength(100);
  });
  it.each(['count', 'key', 'model', 'mismatch', 'budget', 'query', 'capability'])(
    'rejects invalid %s before IO', async kind => {
      const fetch = vi.fn(); const args = input(fetch);
      if (kind === 'count') args.limits.maxCompanies = 2;
      if (kind === 'key') args.credentials.apiKey = '';
      if (kind === 'model') args.credentials.model = '';
      if (kind === 'mismatch') args.credentials.model = 'other';
      if (kind === 'budget') args.limits.maxCostMicros = 4;
      if (kind === 'query') args.query.regions = [];
      if (kind === 'capability') args.capability.searchCostMicros = 0;
      await expect(requestGuidedCompanyDiscovery(args)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });
});

describe('guided response admission', () => {
  it('accepts Unicode provisional model name, ignores titles/offsets, uses one bounded ordinary-text request', async () => {
    const r = reply(); Object.assign(content(r).annotations[0]!, { title: 'NOT THE NAME', start_index: -5, end_index: 99999 });
    const fetch = vi.fn(async () => Response.json(r)); const args = input(fetch);
    const before = JSON.stringify(args.permittedSources);
    expect(await requestGuidedCompanyDiscovery(args)).toEqual([{ name: 'Élan 物業 🏘', domain: 'example.com', sourceUrl: url }]);
    expect(JSON.stringify(args.permittedSources)).toBe(before);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(endpoint).toBe('https://api.openai.com/v1/responses');
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'test-model', store: false, max_output_tokens: 2000,
      max_tool_calls: 1, tool_choice: 'required', include: ['web_search_call.action.sources'],
      tools: [{ type: 'web_search', filters: { allowed_domains: ['example.com'] } }] });
    expect(body.text).toBeUndefined();
    expect(body.instructions).toContain('```json\n{"name":"selected company name","domain":"exact approved hostname"}\n```\nSource for selected company.');
  });
  const mutations: [string, string, (r: Reply) => void][] = [
    ['status', 'envelope_invalid', r => { r.status = 'incomplete'; }],
    ['model', 'envelope_invalid', r => { r.model = 'other'; }],
    ['missing search', 'search_receipt_invalid', r => { r.output.shift(); }],
    ['duplicate search', 'search_receipt_invalid', r => { r.output.unshift(r.output[0]!); }],
    ['incomplete search', 'search_receipt_invalid', r => { r.output[0]!.status = 'in_progress'; }],
    ['wrong action', 'search_receipt_invalid', r => { r.output[0]!.action!.type = 'open_page'; }],
    ['too many sources', 'search_receipt_invalid', r => { r.output[0]!.action!.sources = Array(201).fill({ url }); }],
    ['missing message', 'output_invalid', r => { r.output.pop(); }],
    ['duplicate message', 'output_invalid', r => { r.output.push(r.output[1]!); }],
    ['role', 'output_invalid', r => { r.output[1]!.role = 'user'; }],
    ['message status', 'output_invalid', r => { r.output[1]!.status = 'in_progress'; }],
    ['two contents', 'output_invalid', r => { r.output[1]!.content!.push(content(r)); }],
    ['refusal', 'output_invalid', r => { content(r).type = 'refusal'; }],
    ['oversize text', 'output_invalid', r => { content(r).text = 'x'.repeat(24001); }],
    ['too many annotations', 'output_invalid', r => { content(r).annotations = Array(101).fill({ type: 'url_citation', url }); }],
    ['non URL annotation', 'output_invalid', r => { content(r).annotations[0]!.type = 'file_citation'; }],
    ['invalid annotation URL', 'output_invalid', r => { content(r).annotations[0]!.url = 'not a URL'; }],
    ['long annotation URL', 'output_invalid', r => { content(r).annotations[0]!.url = url + 'x'.repeat(2048); }],
    ['zero annotations', 'citation_missing', r => { content(r).annotations = []; }],
    ['multiple URLs even out of scope', 'output_invalid', r => { content(r).annotations.push({ type: 'url_citation', url: 'https://elsewhere.com/' }); }],
    ['feed labels alone', 'consulted_source_missing', r => { r.output[0]!.action!.sources = [{ type: 'feed', name: url }]; }],
    ['consulted exact mismatch', 'consulted_source_missing', r => { r.output[0]!.action!.sources = [{ url: url + '/' }]; }],
    ['malformed JSON', 'candidate_json_invalid', r => { content(r).text = text().replace('"name":', '"name"'); }],
    ['additional property', 'candidate_json_invalid', r => { content(r).text = text({ name: 'A', domain: 'example.com', sourceUrl: url }); }],
    ['array record', 'candidate_json_invalid', r => { content(r).text = text([{ name: 'A', domain: 'example.com' }]); }],
    ['empty record', 'candidate_json_invalid', r => { content(r).text = text({}); }],
    ['blank name', 'candidate_json_invalid', r => { content(r).text = text({ name: ' ', domain: 'example.com' }); }],
    ['domain capitalization', 'candidate_json_invalid', r => { content(r).text = text({ name: 'A', domain: 'EXAMPLE.com' }); }],
    ['domain mismatch', 'output_invalid', r => { content(r).text = text({ name: 'A', domain: 'other.com' }); }],
  ];
  it.each(mutations)('rejects %s', async (_label, reason, mutate) => { const r = reply(); mutate(r); await rejectsReply(r, reason); });
  it.each([null, {}, { status: 'completed', model: 'test-model', output: Array(31).fill({}) }])('rejects malformed envelope %j', async r => { await rejectsReply(r, 'envelope_invalid'); });
  it.each(['prefix ', ' suffix', '\n{"name":"Other","domain":"other.com"}', '\n' + text()])('rejects extra prose/records %j', async extra => {
    const r = reply(); content(r).text = extra === 'prefix ' ? extra + text() : text() + extra;
    await rejectsReply(r, 'output_invalid');
  });
  it.each([marker, JSON.stringify({ name: 'A', domain: 'example.com' }), JSON.stringify({ companies: [] }),
    text().replace(marker, '[native citation]'), text().replace(marker, '\uE200cite\uE202https://example.com/\uE201'),
    text().replace(marker, '\uE200cite' + '\uE202turn0search0'.repeat(101) + '\uE201')])('rejects unsupported text grammar %j', async value => {
    const r = reply(); content(r).text = value; content(r).annotations = [];
    await rejectsReply(r, 'output_invalid');
  });
  it('accepts duplicate same-URL citations and bounded multi-reference native token', async () => {
    const r = reply(); content(r).annotations.push({ type: 'url_citation', url });
    content(r).text = text().replace(marker, '\uE200cite\uE202turn0search0\uE202turn1search22\uE201');
    expect(await requestGuidedCompanyDiscovery(input(vi.fn(async () => Response.json(r))))).toHaveLength(1);
  });
  it.each(['https://www.example.com/about', 'https://sub.example.com/about', 'https://other.com/',
    'https://narpm.org/', 'https://linkedin.com/', 'https://127.0.0.1/', 'http://example.com/about', 'https://user@example.com/about'])('rejects unapproved/policy URL %s', async sourceUrl => {
    const r = reply(); content(r).annotations[0]!.url = sourceUrl; r.output[0]!.action!.sources = [{ url: sourceUrl }];
    await rejectsReply(r, 'output_invalid');
  });
  it.each([
    '{"name":"First","name":"Second","domain":"example.com"}',
    '{"name":"First","domain":"other.com","domain":"example.com"}',
    '{"name":"First","na\\u006de":"Second"}',
    '{"name":"First","domain":"example.com"}{"name":"Second","domain":"example.com"}',
  ])('rejects conflicting JSON members/records %s', async record => {
    const r = reply(); content(r).text = '```json\n' + record + '\n```\nSource for selected company. ' + marker;
    await rejectsReply(r, 'candidate_json_invalid');
  });
  it('accepts reordered members and ordinary JSON escaped Unicode', async () => {
    const r = reply(); content(r).text = '```json\n{"domain":"example.com","name":"\\u00c9lan \\"Homes\\""}\n```\nSource for selected company. ' + marker;
    expect(await requestGuidedCompanyDiscovery(input(vi.fn(async () => Response.json(r))))).toEqual([
      { name: 'Élan "Homes"', domain: 'example.com', sourceUrl: url },
    ]);
  });
  it('does not normalize equivalent consulted URLs', async () => {
    const r = reply(); content(r).annotations[0]!.url = 'https://example.com';
    r.output[0]!.action!.sources = [{ url: root }];
    await rejectsReply(r, 'consulted_source_missing');
  });
  it('rejects two distinct serialized URL strings even when URL-equivalent', async () => {
    const r = reply(); content(r).annotations = [{ type: 'url_citation', url: root }, { type: 'url_citation', url: 'https://example.com' }];
    await rejectsReply(r, 'output_invalid');
  });
  it('omits legacy numeric summary for missing citation without a claimed source URL', async () => {
    const r = reply(); content(r).annotations = [];
    try { await requestGuidedCompanyDiscovery(input(vi.fn(async () => Response.json(r)))); throw new Error('unexpected success'); }
    catch (error) {
      expect(error).toBeInstanceOf(ResearchDiscoveryError);
      expect(error).toMatchObject({ reason: 'citation_missing' });
      expect((error as ResearchDiscoveryError).citationSummary).toBeUndefined();
      expect(JSON.stringify(error) + String(error)).not.toContain('Élan');
      expect(JSON.stringify(error) + String(error)).not.toContain('example.com');
    }
  });
  it('permits bounded reasoning metadata without relaxing search/message cardinality', async () => {
    const r = reply();
    const envelope = { ...r, output: [...r.output, ...Array.from({ length: 28 }, () => ({ type: 'reasoning', summary: [] }))] };
    expect(await requestGuidedCompanyDiscovery(input(vi.fn(async () => Response.json(envelope))))).toHaveLength(1);
    envelope.output.push({ type: 'reasoning', summary: [] });
    await rejectsReply(envelope, 'envelope_invalid');
  });
  it('accepts maximum source and annotation bounds', async () => {
    const r = reply(); r.output[0]!.action!.sources = Array(200).fill({ url });
    content(r).annotations = Array(100).fill({ type: 'url_citation', url });
    expect(await requestGuidedCompanyDiscovery(input(vi.fn(async () => Response.json(r))))).toHaveLength(1);
  });
  it('does not widen explicitly approved www host to its parent', async () => {
    await expect(requestGuidedCompanyDiscovery({ ...input(), permittedSources: ['https://www.example.com/'] })).rejects.toMatchObject({ reason: 'output_invalid' });
  });
});

describe('one HTTP attempt and sanitized errors', () => {
  it.each([400, 429, 500])('rejects HTTP %s without retry', async status => {
    const fetch = vi.fn(async () => new Response('sensitive body', { status }));
    await expect(requestGuidedCompanyDiscovery(input(fetch))).rejects.toMatchObject({ reason: 'http_rejected', httpStatus: status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['throw', 'reject', 'json', 'declared', 'stream'])('bounds and sanitizes %s failure', async kind => {
    const secret = 'sensitive company https://private.example.com/ secret-token';
    const fetch = vi.fn(() => {
      if (kind === 'throw') throw new Error(secret);
      if (kind === 'reject') return Promise.reject(new Error(secret));
      return Promise.resolve(new Response(kind === 'json' ? secret : 'x'.repeat(100001),
        kind === 'declared' ? { headers: { 'content-length': '100001' } } : undefined));
    });
    try { await requestGuidedCompanyDiscovery(input(fetch)); throw new Error('unexpected success'); }
    catch (error) {
      expect(error).toBeInstanceOf(ResearchDiscoveryError);
      expect(error).toMatchObject({ reason: ['throw', 'reject'].includes(kind) ? 'transport_uncertain' : 'response_body_invalid' });
      expect(String(error) + JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('times out once at 30000ms even when fetch ignores signal', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(() => new Promise<Response>(() => {}));
      const assertion = expect(requestGuidedCompanyDiscovery(input(fetch))).rejects.toMatchObject({ reason: 'transport_uncertain' });
      await vi.advanceTimersByTimeAsync(30000); await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('does no IO for aborted signal', async () => {
    const fetch = vi.fn(); const args = input(fetch); args.signal = AbortSignal.abort();
    await expect(requestGuidedCompanyDiscovery(args)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});
