import { contextLinesIntegration } from '@sentry/node';
import { makePromiseBuffer } from '@sentry/core';
import type { Client, StackFrame, Transport, TransportMakeRequestResponse } from '@sentry/core';
import { sanitizeEnvelope } from './privacy.ts';
import type { ErrorConfiguration } from './privacy.ts';

/** Read approved image SOURCE CODE only after every untrusted event/envelope field is removed. */
export function nodeErrorTransport(
  delegate: Transport,
  configuration: ErrorConfiguration,
  runtimeRoot: string,
  currentClient: () => Client | undefined,
): Transport {
  const context = contextLinesIntegration({ frameContextLines: 3 });
  // Source reads happen before the network delegate can buffer the envelope.
  // Include them in flush so fatal shutdown cannot exit before enrichment/send finishes.
  const pending = makePromiseBuffer<TransportMakeRequestResponse>(30);
  return {
    send(envelope) {
      return pending.add(async () => {
        const safe = sanitizeEnvelope(envelope, configuration);
        const client = currentClient();
        if (!safe || !client || !context.processEvent) throw new Error('Telemetry envelope refused');
        for (const [, event] of safe[1]) {
          const frames = event.exception?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? [];
          const filenames: Array<{ frame: StackFrame; canonical: string }> = [];
          for (const frame of frames) {
            const canonical = frame.filename;
            if (!canonical?.startsWith('app:///')) continue;
            const relative = canonical.slice('app:///'.length);
            if (!configuration.sourceFiles || !Object.hasOwn(configuration.sourceFiles, relative)) continue;
            filenames.push({ frame, canonical });
            frame.filename = `${runtimeRoot}${relative}`;
          }
          try {
            // Explicit 3 overrides global collection=0 solely in this post-privacy source-code step.
            // The maintained hook reads filename/line and adds code pre/context/post lines, no variables.
            const enriched = await context.processEvent(event, {}, client);
            if (!enriched) throw new Error('Telemetry source context refused');
          } finally {
            // No absolute image/local path may cross the network, including on SDK read failures.
            for (const { frame, canonical } of filenames) frame.filename = canonical;
          }
        }
        return await delegate.send(safe);
      });
    },
    async flush(timeout) {
      const started = Date.now();
      try {
        if (!await pending.drain(timeout)) return false;
        if (timeout === undefined) return await delegate.flush();
        const remaining = timeout - (Date.now() - started);
        return remaining > 0 ? await delegate.flush(remaining) : false;
      } catch {
        return false;
      }
    },
  };
}
