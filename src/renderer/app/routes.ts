export const appRoutes = [
  'today',
  'leads',
  'pipeline',
  'conversations',
  'learnings',
  'friday',
  'review',
  'settings',
] as const;

export type AppRoute = (typeof appRoutes)[number];

export const isAppRoute = (value: string): value is AppRoute =>
  (appRoutes as readonly string[]).includes(value);

export const routeHash = (route: AppRoute): string => `#/${route}`;

export const routeFromHash = (hash: string): AppRoute | null => {
  const candidate = hash.replace(/^#\/?/, '');
  return isAppRoute(candidate) ? candidate : null;
};
