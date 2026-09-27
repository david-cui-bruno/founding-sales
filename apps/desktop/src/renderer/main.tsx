import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';

/**
 * The window's entry point (1.0.12).
 *
 * `bundleScheme.ts` declares it and `scripts/bundle.ts` compiles it to `renderer.js`,
 * the one name `index.html` links and the closed scheme map serves.
 *
 * **The Query cache is memory only, deliberately.** There is no persister and there will
 * not be one: this is a request cache, not an offline store. The list that survives an
 * outage is the main process's encrypted 24-hour cache (`offlineCache.ts`), which 5.3
 * puts there and bounds to cards with no bodies, no drafts and no attachments. A
 * persister here would put reply bodies and contact names on the disk in plain JSON,
 * which is the one thing the split in `shared/contract.ts` exists to make impossible.
 */
const client = new QueryClient({
  defaultOptions: {
    queries: {
      // Every read on this Mac is explicit: the views ask when they mean to ask, and a
      // background refetch that reordered the lanes under somebody's hands would be a
      // bug rather than a feature. Today's own focus and rollover rules are in
      // `today/useToday.ts`, where they can be tested.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
      retry: false,
    },
  },
});

const container = document.querySelector('#app');
if (container instanceof HTMLElement) {
  createRoot(container).render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}
