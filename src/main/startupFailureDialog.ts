import { dialog } from 'electron';

/** No error object enters native options. Cleanup authority belongs to main. */
export async function showStartupFailureDialog({ canRestart }: { canRestart: boolean }): Promise<'quit' | 'restart'> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Callie could not start',
    message: 'Callie startup did not complete.',
    detail: 'APPLICATION_STARTUP_FAILED\nQuit Callie to close this attempt. If Restart Callie is offered, you can try starting it again.',
    buttons: canRestart ? ['Quit', 'Restart Callie'] : ['Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return canRestart && response === 1 ? 'restart' : 'quit';
}
