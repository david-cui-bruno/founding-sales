import { describe, expect, it } from 'vitest';

import { navigationItems } from '../../src/renderer/app/navigationItems';

describe('navigationItems', () => {
  it('keeps the exact company-model entries and order with every workspace enabled', () => {
    expect(
      navigationItems.map(({ route, label, enabled }) => ({
        route,
        label,
        enabled,
      })),
    ).toEqual([
      { route: 'today', label: 'Today', enabled: true },
      { route: 'accounts', label: 'Accounts', enabled: true },
      { route: 'campaigns', label: 'Campaigns', enabled: true },
      { route: 'settings', label: 'Settings', enabled: true },
    ]);
  });

  it('carries a renderable icon for every entry', () => {
    for (const item of navigationItems) {
      expect(item.icon).toBeTruthy();
    }
  });
});
