export const appRoutes = ['today', 'accounts', 'campaigns', 'settings'] as const;

export type AppRoute = (typeof appRoutes)[number];

export const isAppRoute = (value: string): value is AppRoute =>
  (appRoutes as readonly string[]).includes(value);

export const routeHash = (route: AppRoute): string => `#/${route}`;

/**
 * The removed person/prospect workspaces. Old links and muscle memory land on
 * Today instead of a blank screen; every other unknown hash stays unresolved.
 */
const legacyRouteHashes: ReadonlySet<string> = new Set([
  'leads', 'pipeline', 'conversations', 'learnings', 'friday', 'inbox', 'review',
]);

export const routeFromHash = (hash: string): AppRoute | null => {
  const candidate = hash.replace(/^#\/?/, '');
  if (legacyRouteHashes.has(candidate)) return 'today';
  return isAppRoute(candidate) ? candidate : null;
};
