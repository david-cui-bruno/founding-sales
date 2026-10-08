export interface NativeNotificationHandle {
  readonly id: string;
  on(event: 'show' | 'click' | 'failed', listener: () => void): unknown;
  show(): void;
  close(): void;
}

/** Main-process adapter only. No renderer permission or browser Notification API. */
export interface NativeNotificationPort {
  supported(): boolean;
  history(): Promise<NativeNotificationHandle[] | null>;
  create(options: { id: string; title: string; body: string; silent: boolean }): NativeNotificationHandle;
}

/** Electron 44.4.5 provides these APIs. A missing history capability is unknown. */
export function createElectronNotificationPort(input: {
  supported(): boolean;
  getHistory?: () => Promise<NativeNotificationHandle[]>;
  create(options: { id: string; title: string; body: string; silent: boolean }): NativeNotificationHandle;
}): NativeNotificationPort {
  return { supported: input.supported, create: input.create,
    async history() { try { return input.getHistory === undefined ? null : await input.getHistory(); } catch { return null; } },
  };
}
