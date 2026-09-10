import { beforeEach, describe, expect, it, vi } from 'vitest';

// Parent-only main gate, even though this helper's Electron surface is mocked.
const { showMessageBox } = vi.hoisted(() => ({
  showMessageBox: vi.fn<(...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>>(),
}));
vi.mock('electron', () => ({ dialog: { showMessageBox } }));

import { showStartupFailureDialog } from '../../src/main/startupFailureDialog';

describe('showStartupFailureDialog', () => {
  beforeEach(() => { showMessageBox.mockReset().mockResolvedValue({ response: 0, checkboxChecked: false }); });

  it.each([false, true])('uses fixed safe options with default and cancel Quit, cleanup confirmed=%s', async canRestart => {
    await expect(showStartupFailureDialog({ canRestart })).resolves.toBe('quit');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox).toHaveBeenCalledWith({
      type: 'error',
      title: 'Callie could not start',
      message: 'Callie startup did not complete.',
      detail: 'APPLICATION_STARTUP_FAILED\nQuit Callie to close this attempt. If Restart Callie is offered, you can try starting it again.',
      buttons: canRestart ? ['Quit', 'Restart Callie'] : ['Quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(JSON.stringify(showMessageBox.mock.calls)).not.toMatch(/restore|reset|\/Users\/|\/private\/|key-secret/i);
  });

  it.each([
    { canRestart: true, response: 1, expected: 'restart' },
    { canRestart: false, response: 1, expected: 'quit' },
    { canRestart: true, response: 0, expected: 'quit' },
    { canRestart: true, response: -1, expected: 'quit' },
    { canRestart: true, response: 2, expected: 'quit' },
    { canRestart: false, response: -1, expected: 'quit' },
    { canRestart: false, response: 2, expected: 'quit' },
  ] as const)('maps only permitted explicit response1: $canRestart/$response', async ({ canRestart, response, expected }) => {
    showMessageBox.mockResolvedValue({ response, checkboxChecked: false });
    await expect(showStartupFailureDialog({ canRestart })).resolves.toBe(expected);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('passes native dialog rejection to main without retrying or interpolating it', async () => {
    const failure = new Error('/private/key-secret');
    showMessageBox.mockRejectedValue(failure);
    await expect(showStartupFailureDialog({ canRestart: true })).rejects.toBe(failure);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(showMessageBox.mock.calls)).not.toContain('/private/key-secret');
  });
});
