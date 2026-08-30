import type { AppHealth } from './healthContract';

declare global {
  interface Window {
    callie: {
      health: {
        get(): Promise<AppHealth>;
      };
    };
  }
}

export {};
