import { describe, expect, it } from 'vitest';

import { navigationItems } from '../../src/renderer/app/navigationItems';

describe('navigationItems', () => {
  it('keeps the exact entries and order with every workspace enabled', () => {
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
      { route: 'leads', label: 'Leads', enabled: true },
      { route: 'pipeline', label: 'Pipeline', enabled: true },
      { route: 'conversations', label: 'Conversations', enabled: true },
      { route: 'learnings', label: 'Learnings', enabled: true },
      { route: 'friday', label: 'Friday', enabled: true },
      { route: 'inbox', label: 'Inbox', enabled: true },
      { route: 'settings', label: 'Settings', enabled: true },
    ]);
  });

  it('carries a renderable icon for every entry', () => {
    for (const item of navigationItems) {
      expect(item.icon).toBeTruthy();
    }
  });
});
