export const appRoutes = [
  'today',
  'leads',
  'pipeline',
  'conversations',
  'learnings',
  'friday',
  'inbox',
  'settings',
] as const;

export type AppRoute = (typeof appRoutes)[number];

export const isAppRoute = (value: string): value is AppRoute =>
  (appRoutes as readonly string[]).includes(value);

export const routeHash = (route: AppRoute): string => `#/${route}`;

export const routeFromHash = (hash: string): AppRoute | null => {
  const candidate = hash.replace(/^#\/?/, '');
  // Review was renamed Inbox; old links and muscle memory keep working.
  if (candidate === 'review') return 'inbox';
  return isAppRoute(candidate) ? candidate : null;
};
