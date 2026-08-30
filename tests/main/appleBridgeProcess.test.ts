import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { AppleBridgeClient } from '../../src/main/appleBridge/appleBridgeClient';
import {
  APPLE_BRIDGE_MAX_FRAME_BYTES,
  APPLE_BRIDGE_MAX_STDERR_BYTES,
  AppleBridgeProcess,
  launchAppleBridgeProcess,
  spawnAppleBridge,
  type AppleBridgeChildProcess,
  type AppleBridgeProcessEvent,
} from '../../src/main/appleBridge/appleBridgeProcess';

class FakeChildProcess extends EventEmitter implements AppleBridgeChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Buffer[] = [];
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.writes.push(Buffer.from(chunk));
      callback();
    },
  });
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const emitErrorAsync = async (emitter: EventEmitter, message: string): Promise<void> => {
  await Promise.resolve();
  emitter.emit('error', new Error(message));
};

const assertChildListenersRemoved = (child: FakeChildProcess): void => {
  expect(child.listenerCount('error')).toBe(0);
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.stdin.listenerCount('error')).toBe(0);
  expect(child.stdout.listenerCount('error')).toBe(0);
  expect(child.stderr.listenerCount('error')).toBe(0);
  expect(child.stdout.listenerCount('data')).toBe(0);
  expect(child.stderr.listenerCount('data')).toBe(0);
  expect(child.stderr.listenerCount('end')).toBe(0);
};

const completeRealProcessHandshake = (
  child: FakeChildProcess,
  helloId: string,
): void => {
  child.stdout.write(`${JSON.stringify({
    v: 1,
    kind: 'response',
    id: helloId.toUpperCase(),
    ok: true,
    result: { selectedVersion: 1, helperVersion: '1.0.0-test' },
  })}\n`);
};

const collect = (process: AppleBridgeProcess): AppleBridgeProcessEvent[] => {
  const events: AppleBridgeProcessEvent[] = [];
  process.subscribe((event) => events.push(event));
  return events;
};

describe('AppleBridgeProcess', () => {
  it('parses split and coalesced JSONL frames in wire order', () => {
    const child = new FakeChildProcess();
    const process = new AppleBridgeProcess(child);
    const events = collect(process);

    child.stdout.write('{"kind":"event","seq":1}\n{"kind":"res');
    child.stdout.write('ponse","id":"one"}\n');

    expect(events).toEqual([
      { type: 'frame', frame: { kind: 'event', seq: 1 } },
      { type: 'frame', frame: { kind: 'response', id: 'one' } },
    ]);
  });

  it('accepts an exactly bounded physical frame and rejects one byte more before parsing', () => {
    const exactChild = new FakeChildProcess();
    const exactProcess = new AppleBridgeProcess(exactChild);
    const exactEvents = collect(exactProcess);
    const prefix = Buffer.from('{"value":1}');
    exactChild.stdout.write(Buffer.concat([
      prefix,
      Buffer.alloc(APPLE_BRIDGE_MAX_FRAME_BYTES - prefix.length - 1, 0x20),
      Buffer.from('\n'),
    ]));
    expect(exactEvents).toEqual([
      { type: 'frame', frame: { value: 1 } },
    ]);

    const oversizedChild = new FakeChildProcess();
    const oversizedProcess = new AppleBridgeProcess(oversizedChild);
    const oversizedEvents = collect(oversizedProcess);
    oversizedChild.stdout.write(Buffer.alloc(APPLE_BRIDGE_MAX_FRAME_BYTES, 0x78));

    expect(oversizedEvents).toHaveLength(1);
    expect(oversizedEvents[0]).toMatchObject({ type: 'failure' });
    expect((oversizedEvents[0] as { error: Error }).error.message).toContain('262144');
  });

  it('fails closed on malformed JSON without emitting the malformed payload', () => {
    const child = new FakeChildProcess();
    const process = new AppleBridgeProcess(child);
    const events = collect(process);

    child.stdout.write('{not-json}\n');
    child.stdout.write('{"kind":"event","seq":2}\n');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'failure' });
    expect(child.killed).toBe(true);
  });

  it('rejects invalid UTF-8 before JSON parsing and terminates the helper', () => {
    const child = new FakeChildProcess();
    const process = new AppleBridgeProcess(child);
    const events = collect(process);

    child.stdout.write(Buffer.from([0x7B, 0xFF, 0x7D, 0x0A]));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'failure' });
    expect((events[0] as { error: Error }).error.message).toBe(
      'Apple bridge emitted a malformed JSONL protocol frame.',
    );
    expect(child.killed).toBe(true);
  });

  it.each([
    ['stdin', (child: FakeChildProcess): EventEmitter => child.stdin],
    ['stdout', (child: FakeChildProcess): EventEmitter => child.stdout],
    ['stderr', (child: FakeChildProcess): EventEmitter => child.stderr],
    ['child process', (child: FakeChildProcess): EventEmitter => child],
  ])('fails pending work safely on an asynchronous %s error', async (_name, selectEmitter) => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      const process = new AppleBridgeProcess(child);
      const helloId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const client = new AppleBridgeClient(process, { createRequestId: () => helloId });
      completeRealProcessHandshake(child, helloId);
      const request = {
        v: 1,
        kind: 'request',
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        method: 'capabilities.probe',
        params: {},
      } as const;
      const pending = client.request(request, 60_000);
      const rejection = expect(pending).rejects.toThrow(
        'Apple bridge protocol transport failed: Apple bridge process transport failed.',
      );
      await Promise.resolve();

      await expect(emitErrorAsync(selectEmitter(child), 'private /Users/founder leaked')).resolves.toBeUndefined();

      await rejection;
      expect(child.killed).toBe(true);
      expect(child.writes.filter((buffer) => buffer.includes('capabilities.probe'))).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      process.dispose();
      assertChildListenersRemoved(child);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles an asynchronous stdin error after end and removes every owned listener', async () => {
    const child = new FakeChildProcess();
    const process = new AppleBridgeProcess(child);
    const events = collect(process);
    process.closeInput();

    await expect(emitErrorAsync(child.stdin, 'late EPIPE /Users/founder')).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'failure',
      error: { message: 'Apple bridge process transport failed.' },
    });
    expect(child.killed).toBe(true);
    process.dispose();
    assertChildListenersRemoved(child);
  });

  it('retains at most 32 KiB of sanitized stderr diagnostics only', () => {
    const child = new FakeChildProcess();
    const process = new AppleBridgeProcess(child);
    const events = collect(process);

    child.stderr.write('contact founder@example.com at +1 (555) 555-0100 ');
    child.stderr.write('from /Users/founder/Library/Callie/private.txt\n');
    child.stderr.write('x'.repeat(APPLE_BRIDGE_MAX_STDERR_BYTES * 2));
    child.stderr.end();

    expect(Buffer.byteLength(process.diagnostics, 'utf8')).toBeLessThanOrEqual(
      APPLE_BRIDGE_MAX_STDERR_BYTES,
    );
    expect(process.diagnostics).not.toContain('founder@example.com');
    expect(process.diagnostics).not.toContain('555-0100');
    expect(process.diagnostics).not.toContain('/Users/founder');
    expect(process.diagnostics).toContain('[email]');
    expect(process.diagnostics).toContain('[phone]');
    expect(process.diagnostics).toContain('[path]');
    expect(events).toEqual([]);
  });

  it('reports process exit through the bounded event channel', () => {
    const child = new FakeChildProcess();
    const process = new AppleBridgeProcess(child);
    const events = collect(process);

    child.emit('exit', 9, null);

    expect(events).toEqual([{ type: 'exit', code: 9, signal: null }]);
  });

  it('spawns with no shell, a fixed staging argument, and an allowlisted environment', () => {
    const fakeChild = new FakeChildProcess();
    let invocation: unknown;
    const spawnProcess = (executable: string, args: readonly string[], options: object) => {
      invocation = { executable, args: [...args], options };
      return fakeChild;
    };

    expect(spawnAppleBridge('/fixed/CallieAppleBridge', '/fixed/staging', spawnProcess)).toBe(fakeChild);
    expect(invocation).toEqual({
      executable: '/fixed/CallieAppleBridge',
      args: ['--staging-root', '/fixed/staging'],
      options: {
        env: { LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    });
  });

  it('verifies a packaged helper before invoking the spawn boundary', async () => {
    const order: string[] = [];
    const fakeChild = new FakeChildProcess();

    await expect(launchAppleBridgeProcess({
      executablePath: '/fixed/CallieAppleBridge',
      stagingRoot: '/fixed/staging',
      isPackaged: true,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      expectedTeamIdentifier: 'TEAM123456',
      verify: async () => {
        order.push('verify');
        return {
          signed: true,
          identifier: 'com.callie.foundersales.applebridge',
          teamIdentifier: 'TEAM123456',
        };
      },
      spawnProcess: () => {
        order.push('spawn');
        return fakeChild;
      },
    })).resolves.toBeInstanceOf(AppleBridgeProcess);
    expect(order).toEqual(['verify', 'spawn']);
  });

  it('does not spawn when packaged signature verification rejects', async () => {
    let spawned = false;

    await expect(launchAppleBridgeProcess({
      executablePath: '/fixed/CallieAppleBridge',
      stagingRoot: '/fixed/staging',
      isPackaged: true,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      expectedTeamIdentifier: 'TEAM123456',
      verify: async () => {
        throw new Error('helper identifier mismatch');
      },
      spawnProcess: () => {
        spawned = true;
        return new FakeChildProcess();
      },
    })).rejects.toThrow('identifier');
    expect(spawned).toBe(false);
  });
});
