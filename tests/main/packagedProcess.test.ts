import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { terminatePackagedApplication } from '../support/packagedApplication';

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn<(signal: NodeJS.Signals) => boolean>();

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

describe('terminatePackagedApplication', () => {
  it('waits for the process exit after SIGTERM', async () => {
    const process = new FakeProcess();
    process.kill.mockImplementation((signal) => {
      setTimeout(() => process.exit(0, signal), 0);
      return true;
    });

    await expect(terminatePackagedApplication(process, 20)).resolves.toEqual({
      code: 0,
      signal: 'SIGTERM',
    });
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates to SIGKILL when SIGTERM does not stop the process', async () => {
    const process = new FakeProcess();
    process.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        setTimeout(() => process.exit(null, signal), 0);
      }
      return true;
    });

    await expect(terminatePackagedApplication(process, 20)).resolves.toEqual({
      code: null,
      signal: 'SIGKILL',
    });
    expect(process.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(process.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('reports an already exited numeric code without signalling it again', async () => {
    const process = new FakeProcess();
    process.exitCode = 9;

    await expect(terminatePackagedApplication(process, 20)).resolves.toEqual({
      code: 9,
      signal: null,
    });
    expect(process.kill).not.toHaveBeenCalled();
  });
});
