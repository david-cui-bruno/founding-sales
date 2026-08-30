import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

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

  it('reports process exit and process errors through the same bounded event channel', () => {
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
