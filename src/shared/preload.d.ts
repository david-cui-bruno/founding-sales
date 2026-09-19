import type { CallieApi } from '../preload/createCallieApi';

/**
 * The complete window bridge: the strict workflow API composed by
 * `createCallieApi` (including explicit phone setup, never call observation).
 */
export type CalliePreloadApi = CallieApi;

declare global {
  interface Window {
    callie: CalliePreloadApi;
  }
}

export {};
