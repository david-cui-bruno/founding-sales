#!/usr/bin/env node

// Inert protocol fixture for packaged-process tests. It only supports the
// handshake, capability probe, and graceful shutdown; it never opens Apple
// apps, URLs, databases, or permission prompts.
import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin, terminal: false });

lines.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stderr.write('fake-helper: invalid frame\n');
    return;
  }

  if (request?.method === 'bridge.hello') {
    process.stdout.write(`${JSON.stringify({
      v: 1,
      kind: 'response',
      id: request.id,
      ok: true,
      result: {
        selectedVersion: 1,
        helperVersion: '1.0.0-test',
      },
    })}\n`);
    return;
  }

  if (request?.method === 'capabilities.probe') {
    process.stdout.write(`${JSON.stringify({
      v: 1,
      kind: 'response',
      id: request.id,
      ok: true,
      result: { testFixture: true },
    })}\n`);
    return;
  }

  if (request?.method === 'bridge.shutdown') {
    process.stdout.write(`${JSON.stringify({
      v: 1,
      kind: 'response',
      id: request.id,
      ok: true,
      result: { shuttingDown: true },
    })}\n`);
    lines.close();
    return;
  }

  process.stdout.write(`${JSON.stringify({
    v: 1,
    kind: 'response',
    id: request?.id,
    ok: false,
    error: {
      code: 'capability_unavailable',
      message: 'The inert fake helper does not implement this method.',
      retryable: false,
    },
  })}\n`);
});
