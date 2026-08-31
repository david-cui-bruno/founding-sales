import type { Mock } from 'vitest';

export type IpcInvokeEvent = { senderFrame: { url: string } };

export type RegisteredIpcHandler = (
  event: IpcInvokeEvent,
  ...args: unknown[]
) => unknown;

export function registeredIpcHandler(
  handle: Mock,
  channel: string,
): RegisteredIpcHandler {
  const registration = handle.mock.calls.find(
    (call) => call[0] === channel,
  ) as [string, RegisteredIpcHandler] | undefined;

  if (registration === undefined) {
    throw new Error(`${channel} was not registered`);
  }

  return registration[1];
}
