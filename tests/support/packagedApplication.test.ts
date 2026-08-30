import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  assertPackagedDescendantsExit,
  snapshotPackagedProcessTree,
  waitForPackagedChildProcess,
  type PackagedProcessEntry,
} from './packagedApplication';

describe('packaged application process-tree inspection', () => {
  it('walks only the supplied packaged root and descendant PIDs', async () => {
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === '/usr/bin/pgrep') {
        return {
          '4100': '4101\n4102',
          '4101': '4103',
          '4102': '',
          '4103': '',
        }[args[1]] ?? '';
      }
      if (command === '/bin/ps') {
        return {
          '4101': '4100 /Applications/Callie Helper',
          '4102': '4100 /Applications/Electron Helper',
          '4103': '4101 /Applications/CallieAppleBridge',
        }[args[1]] ?? '';
      }
      throw new Error(`Unexpected process command ${command}`);
    });

    const entries = await snapshotPackagedProcessTree(4100, { runCommand });

    expect(entries).toEqual([
      { pid: 4101, parentPid: 4100, command: '/Applications/Callie Helper' },
      { pid: 4102, parentPid: 4100, command: '/Applications/Electron Helper' },
      { pid: 4103, parentPid: 4101, command: '/Applications/CallieAppleBridge' },
    ]);
    expect(commands.filter(({ command }) => command === '/usr/bin/pgrep')).toEqual([
      { command: '/usr/bin/pgrep', args: ['-P', '4100'] },
      { command: '/usr/bin/pgrep', args: ['-P', '4101'] },
      { command: '/usr/bin/pgrep', args: ['-P', '4102'] },
      { command: '/usr/bin/pgrep', args: ['-P', '4103'] },
    ]);
    expect(commands.some(({ args }) => args.includes('9999'))).toBe(false);
  });

  it('waits until the packaged helper appears beneath the supplied root', async () => {
    const helper: PackagedProcessEntry = {
      pid: 5201,
      parentPid: 5200,
      command: '/Applications/CallieAppleBridge',
    };
    const snapshots = [[], [helper]];

    const found = await waitForPackagedChildProcess(
      5200,
      (entry) => entry.command.endsWith('/CallieAppleBridge'),
      {
        timeoutMs: 25,
        pollIntervalMs: 0,
        snapshotProcessTree: async () => snapshots.shift() ?? [helper],
      },
    );

    expect(found).toEqual(helper);
  });

  it('confirms tracked descendants exit without inspecting unrelated processes', async () => {
    const helper: PackagedProcessEntry = {
      pid: 6201,
      parentPid: 6200,
      command: '/Applications/CallieAppleBridge',
    };
    const inspectTrackedProcess = vi
      .fn()
      .mockResolvedValueOnce(helper)
      .mockResolvedValueOnce(undefined);
    const signalProcess = vi.fn();

    await assertPackagedDescendantsExit([helper], {
      timeoutMs: 25,
      pollIntervalMs: 0,
      inspectTrackedProcess,
      signalProcess,
    });

    expect(inspectTrackedProcess).toHaveBeenCalledWith(helper);
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it('treats a vanished tracked PID as an exited process', async () => {
    const shortLived = spawn(process.execPath, ['-e', '']);
    await new Promise<void>((resolve, reject) => {
      shortLived.once('error', reject);
      shortLived.once('exit', () => resolve());
    });
    expect(shortLived.pid).toBeTypeOf('number');

    await expect(assertPackagedDescendantsExit([{
      pid: shortLived.pid as number,
      parentPid: 6200,
      command: '/Applications/CallieAppleBridge-that-does-not-exist',
    }], { timeoutMs: 25, pollIntervalMs: 0 })).resolves.toBeUndefined();
  });

  it('force-cleans an exact still-running tracked helper and reports the lifecycle leak', async () => {
    const helper: PackagedProcessEntry = {
      pid: 7201,
      parentPid: 7200,
      command: '/Applications/CallieAppleBridge',
    };
    const inspectTrackedProcess = vi.fn().mockResolvedValue(helper);
    const signalProcess = vi.fn();

    await expect(assertPackagedDescendantsExit([helper], {
      timeoutMs: 0,
      pollIntervalMs: 0,
      inspectTrackedProcess,
      signalProcess,
    })).rejects.toThrow('did not exit with the packaged application');

    expect(signalProcess).toHaveBeenCalledWith(helper.pid, 'SIGKILL');
  });
});
