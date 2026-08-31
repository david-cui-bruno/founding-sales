import { useCallback, useEffect, useState } from 'react';

import { routeFromHash, routeHash, type AppRoute } from './routes';

export type HashRouting = {
  route: AppRoute;
  navigate(route: AppRoute): void;
};

const currentRoute = (fallback: AppRoute): AppRoute =>
  routeFromHash(window.location.hash) ?? fallback;

/**
 * Hash-backed routing so navigation uses real same-window anchors and the
 * route survives reloads. Unknown hashes fall back to the initial route.
 */
export function useHashRoute(initialRoute: AppRoute): HashRouting {
  const [route, setRoute] = useState<AppRoute>(() => currentRoute(initialRoute));

  useEffect(() => {
    const onHashChange = () => {
      const next = routeFromHash(window.location.hash);
      if (next !== null) {
        setRoute(next);
      }
    };

    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: AppRoute) => {
    window.location.hash = routeHash(next);
    setRoute(next);
  }, []);

  return { route, navigate };
}
