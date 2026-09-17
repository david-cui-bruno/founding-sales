import { describe, expect, it } from 'vitest';

import { appRoutes, routeFromHash, routeHash } from '../../src/renderer/app/routes';

describe('routes', () => {
  it('exposes exactly the company-model routes', () => {
    expect([...appRoutes]).toEqual(['today', 'accounts', 'campaigns', 'settings']);
  });

  it('resolves every company-model hash to its route', () => {
    for (const route of appRoutes) expect(routeFromHash(routeHash(route))).toBe(route);
  });

  it.each(['leads', 'pipeline', 'conversations', 'learnings', 'friday', 'inbox', 'review'])(
    'resolves the removed legacy hash #/%s to Today',
    (legacy) => {
      expect(routeFromHash(`#/${legacy}`)).toBe('today');
    },
  );

  it('keeps unknown hashes unresolved', () => {
    expect(routeFromHash('#/unknown-route')).toBeNull();
    expect(routeFromHash('')).toBeNull();
  });
});
