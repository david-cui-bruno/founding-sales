import type { ClientApi } from '../preload/clientApi';

/** The whole window bridge of the thin client: the seven validated operations `preload.ts` exposes. */
declare global {
  interface Window {
    callie: ClientApi;
  }
}

export {};
