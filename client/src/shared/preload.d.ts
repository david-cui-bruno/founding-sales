import type { ClientApi } from '../preload/clientApi';

/** The whole window bridge of the thin client: the five validated operations `preload.ts` exposes. */
declare global {
  interface Window {
    callie: ClientApi;
  }
}

export {};
