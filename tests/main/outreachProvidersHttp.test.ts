import { describe, expect, it } from 'vitest';
import { generateOpenAiDraft } from '../../src/main/outreach/providers/openAiDraftProvider';
import { createPreparedGmailSender } from '../../src/main/outreach/providers/gmailProvider';
import type { FrozenEmail, GroundedDraftContext } from '../../src/main/outreach/providers/providerTypes';

const context: GroundedDraftContext = { personName: 'Owner', organizationLabel: null, segment: 'warm', stage: 'ready',
  actionLabel: 'Reply to introduction', facts: [{ id: 'property-1', text: 'Known managed holdings: 2 properties (partial).' }],
  playbook: 'Research first. Never invent prior contact or pain.' };
const email: FrozenEmail = { commandId: '00000000-0000-4000-8000-000000000001', from: 'founder@example.com',
  to: 'owner@example.com', subject: 'Two properties?', body: 'Hello Owner,\nMay we talk?' };
const output = (evidenceIds = ['property-1']) => ({ id: 'resp_fixture', status: 'completed', model: 'fixture-model',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
    text: JSON.stringify({ subject: 'Two properties?', body: 'May we talk?', evidenceIds }) }] }] });

describe('OpenAI structured grounded drafts', () => {
  it('sends bounded facts with store:false and strict schema to the fixed endpoint', async () => {
    let observed: { url: string; init: RequestInit };
    const result = await generateOpenAiDraft({ credentials: { apiKey: 'fixture-secret', model: 'fixture-model' }, context,
      signal: new AbortController().signal, fetch: async (url, init) => {
        observed = { url: String(url), init }; return Response.json(output());
      } });
    expect(result).toEqual({ subject: 'Two properties?', body: 'May we talk?', evidenceIds: ['property-1'],
      provider: 'openai', model: 'fixture-model', responseId: 'resp_fixture' });
    expect(observed.url).toBe('https://api.openai.com/v1/responses');
    expect(observed.init.redirect).toBe('error');
    const body = JSON.parse(String(observed.init.body));
    expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(body.input).toContain('Known managed holdings');
    expect(body.input).not.toContain('fixture-secret');
    expect(body.max_output_tokens).toBeGreaterThan(0);
  });
  it.each([
    ['unknown evidence', () => Response.json(output(['invented']))],
    ['oversized response', () => new Response('x'.repeat(300000))],
    ['incomplete output', () => Response.json({ ...output(), status: 'incomplete' })],
    ['provider error text', () => new Response('fixture-secret provider exception', { status: 401 })],
  ])('rejects %s without leaking provider data', async (_name, response) => {
    const result = generateOpenAiDraft({ credentials: { apiKey: 'fixture-secret', model: 'fixture-model' }, context,
      signal: new AbortController().signal, fetch: async () => response() });
    await expect(result).rejects.toThrow(/^(ungrounded_output|provider_response_invalid|provider_rejected)$/);
  });
  it('rejects unknown context fields and excessive facts before HTTP', async () => {
    let requests = 0;
    const fetcher: typeof fetch = async () => { requests++; return Response.json(output()); };
    await expect(generateOpenAiDraft({ credentials: { apiKey: 'key', model: 'model' },
      context: { ...context, noteText: 'private local-only note' } as GroundedDraftContext,
      signal: new AbortController().signal, fetch: fetcher })).rejects.toThrow('invalid_draft_context');
    await expect(generateOpenAiDraft({ credentials: { apiKey: 'key', model: 'model' },
      context: { ...context, facts: Array.from({ length: 201 }, (_, i) => ({ id: String(i), text: 'fact' })) },
      signal: new AbortController().signal, fetch: fetcher })).rejects.toThrow('invalid_draft_context');
    expect(requests).toBe(0);
  });
});

describe('single-invocation Gmail sender', () => {
  function sender(fetcher: typeof fetch, options: { timeoutMs?: number; isCurrent?: () => boolean } = {}) {
    return createPreparedGmailSender({ accountEmail: email.from, accessToken: 'fixture-access', fetch: fetcher,
      signal: new AbortController().signal, isCurrent: options.isCurrent ?? (() => true), timeoutMs: options.timeoutMs });
  }
  it('invokes immediately, emits safe MIME and observes duplicate calls without another request', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const prepared = sender(async (url, init) => { requests.push({ url: String(url), init }); return Response.json({ id: 'message1', threadId: 'thread1' }); });
    const first = prepared.sendOnce(email);
    expect(requests).toHaveLength(1); // Before any await: required by reservation boundary.
    expect(prepared.sendOnce(email)).toBe(first);
    expect(await first).toEqual({ status: 'accepted', messageId: 'message1', threadId: 'thread1' });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(requests[0].init.redirect).toBe('error');
    const mime = Buffer.from(JSON.parse(String(requests[0].init.body)).raw, 'base64url').toString('utf8');
    expect(mime).toContain('To: owner@example.com\r\n');
    expect(mime).toContain('From: founder@example.com\r\n');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime).not.toContain('fixture-access');
    expect(await prepared.sendOnce({ ...email, body: 'changed' })).toEqual({ status: 'not_sent', reasonCode: 'command_conflict' });
  });
  it.each([
    { ...email, to: 'owner@example.com\r\nBcc: victim@example.com' },
    { ...email, subject: 'Hello\r\nBcc: victim@example.com' },
    { ...email, from: 'different@example.com' },
    { ...email, commandId: 'id\r\nmalicious' },
  ])('refuses invalid MIME/account input before sending', async (input) => {
    let requests = 0;
    const prepared = sender(async () => { requests++; return Response.json({ id: 'm' }); });
    expect((await prepared.sendOnce(input)).status).toBe('not_sent');
    expect(requests).toBe(0);
  });
  it('classifies network timeout as unknown without retries even if fetch ignores abort', async () => {
    let requests = 0;
    const prepared = sender(() => { requests++; return new Promise(() => undefined); }, { timeoutMs: 10 });
    const promise = prepared.sendOnce(email);
    expect(await promise).toEqual({ status: 'unknown', reasonCode: 'network_uncertain' });
    expect(await prepared.sendOnce(email)).toEqual({ status: 'unknown', reasonCode: 'network_uncertain' });
    expect(requests).toBe(1);
  });
  it.each([401, 429, 500])('never retries rejected HTTP status %s', async (status) => {
    let requests = 0;
    const prepared = sender(async () => { requests++; return new Response('secret error', { status }); });
    expect(await prepared.sendOnce(email)).toEqual(status < 500
      ? { status: 'not_sent', reasonCode: 'provider_rejected' }
      : { status: 'unknown', reasonCode: 'network_uncertain' });
    expect(requests).toBe(1);
  });
  it('refuses epoch-invalid sender and bounds streamed success data', async () => {
    let requests = 0;
    const prepared = sender(async () => { requests++; return Response.json({ id: 'm' }); }, { isCurrent: () => false });
    expect(await prepared.sendOnce(email)).toEqual({ status: 'not_sent', reasonCode: 'provider_invalidated' });
    expect(requests).toBe(0);
    const oversized = sender(async () => new Response('x'.repeat(300000)));
    expect(await oversized.sendOnce(email)).toEqual({ status: 'unknown', reasonCode: 'network_uncertain' });
  });
  it('observes synchronous failures and late replies without another send', async () => {
    let calls = 0;
    const throwing = sender(() => { calls++; throw new Error('secret port failure'); });
    expect(await throwing.sendOnce(email)).toEqual({ status: 'unknown', reasonCode: 'network_uncertain' });
    let finish: (response: Response) => void;
    const late = sender(() => { calls++; return new Promise<Response>((resolve) => { finish = resolve; }); }, { timeoutMs: 10 });
    expect(await late.sendOnce(email)).toEqual({ status: 'unknown', reasonCode: 'network_uncertain' });
    finish(Response.json({ id: 'late_message' }));
    expect(await late.sendOnce(email)).toEqual({ status: 'unknown', reasonCode: 'network_uncertain' });
    expect(calls).toBe(2);
  });
  it('bounds a never-finishing response body and cancels its stream', async () => {
    let cancelled = false;
    const prepared = sender(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); },
      cancel() { cancelled = true; },
    })), { timeoutMs: 10 });
    expect(await prepared.sendOnce(email)).toEqual({ status: 'unknown', reasonCode: 'network_uncertain' });
    expect(cancelled).toBe(true);
  });
  it('handles a reentrant send request without opening a second flight', async () => {
    let calls = 0;
    let reentrant: Promise<unknown>;
    const prepared: ReturnType<typeof sender> = sender(async () => { calls++; reentrant = prepared.sendOnce(email); return Response.json({ id: 'm' }); });
    const first = prepared.sendOnce(email);
    expect(reentrant).toBe(first);
    expect(await first).toMatchObject({ status: 'accepted' });
    expect(calls).toBe(1);
  });
});
