import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeClient, defaultStackParser, makeNodeTransport } from '@sentry/node';
import { createTransport } from '@sentry/core';
import type { EventEnvelope } from '@sentry/core';
import { nodeErrorTransport } from '../src/nodeTransport.ts';
import { errorOptions } from '../src/privacy.ts';

describe('post-privacy native source context', () => {
  it('replaces hostile runtime context only with actual approved source read by the maintained SDK', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fss-private-source-'));
    const runtimeRoot = `${directory}/`;
    const rawCanary = 'PRIVATE_RUNTIME_EMAIL_PROMPT_TOKEN';
    const rejectedSourceCanary = 'UNAPPROVED_SOURCE_MUST_NOT_BE_READ';
    const sourceLine = "  throw new Error('APPROVED_SOURCE_CODE_ONLY');";
    try {
      await mkdir(join(directory, 'apps/api/src'), { recursive: true });
      await writeFile(join(directory, 'apps/api/src/server.ts'), [
        '// Approved fixture source, never request data.',
        'export function fixture() {',
        '  const staticCode = 1;',
        sourceLine,
        '}',
      ].join('\n'));
      await writeFile(join(directory, 'apps/api/src/unapproved.ts'), rejectedSourceCanary);
      const configuration = {
        release: 'a'.repeat(40), service: 'api' as const, runtimeRoot,
        sourceFiles: { 'apps/api/src/server.ts': true as const },
      };
      const client = new NodeClient({
        ...errorOptions(configuration), stackParser: defaultStackParser,
        transport: makeNodeTransport, integrations: [],
      });
      const raw: EventEnvelope = [{ event_id: 'b'.repeat(32), sent_at: '2026-11-03T00:00:00.000Z' }, [[{ type: 'event' }, {
        type: undefined, event_id: 'b'.repeat(32),
        exception: { values: [{ type: 'Error', value: rawCanary, stacktrace: { frames: [
          {
            filename: `${runtimeRoot}apps/api/src/unapproved.ts`, lineno: 1,
            context_line: rawCanary,
          },
          {
            filename: `${runtimeRoot}apps/api/src/server.ts`, lineno: 4,
            context_line: rawCanary, pre_context: [rawCanary], post_context: [rawCanary],
            vars: { secret: rawCanary }, function: rawCanary,
          },
        ] } }] },
      }]]];
      let body: string | Uint8Array | undefined;
      const delegate = createTransport({ recordDroppedEvent: () => {} }, (request) => {
        body = request.body;
        return Promise.resolve({ statusCode: 202 });
      });
      const transport = nodeErrorTransport(delegate, configuration, runtimeRoot, () => client);
      const sending = transport.send(raw);
      expect(await transport.flush(2000)).toBe(true);
      expect(await sending).toEqual({ statusCode: 202 });
      const encoded = typeof body === 'string' ? body : new TextDecoder().decode(body);
      expect(encoded).toContain(`"context_line":${JSON.stringify(sourceLine)}`);
      expect(encoded).toContain('app:///apps/api/src/server.ts');
      expect(encoded).not.toContain(rawCanary);
      expect(encoded).not.toContain(rejectedSourceCanary);
      expect(encoded).not.toContain(runtimeRoot);
      expect(encoded).not.toContain('unapproved.ts');
      // Context enrichment mutates only a fresh sanitized event, not the caller's object.
      expect(JSON.stringify(raw)).toContain(rawCanary);
      expect(JSON.stringify(raw)).not.toContain('APPROVED_SOURCE_CODE_ONLY');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
