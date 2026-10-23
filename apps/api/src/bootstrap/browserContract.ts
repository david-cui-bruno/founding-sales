import type { RequestListener } from 'node:http';

/** Exact configured browser host, never a proxy-derived authority. */
export interface ApiBrowserMount {
  readonly origin: string;
  readonly handler: RequestListener;
}
