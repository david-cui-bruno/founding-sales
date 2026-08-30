import type { IpcMainInvokeEvent } from 'electron';

import { isTrustedRendererUrl } from '../navigationPolicy';

export function validateSender(
  event: Pick<IpcMainInvokeEvent, 'senderFrame'>,
  isTrustedUrl: (url: string) => boolean = isTrustedRendererUrl,
): void {
  if (!isTrustedUrl(event.senderFrame?.url ?? '')) {
    throw new Error('IPC request did not come from a trusted renderer.');
  }
}
