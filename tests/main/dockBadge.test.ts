import { describe, expect, it, vi } from 'vitest';

import {
  badgeTextForCount,
  createDockBadgeUpdater,
} from '../../src/main/dockBadge';

describe('badgeTextForCount', () => {
  it('renders positive counts as text and everything else as empty', () => {
    expect(badgeTextForCount(3)).toBe('3');
    expect(badgeTextForCount(1)).toBe('1');
    expect(badgeTextForCount(0)).toBe('');
    expect(badgeTextForCount(-2)).toBe('');
  });
});

describe('createDockBadgeUpdater', () => {
  it('shows the due count as the badge text', () => {
    const setBadge = vi.fn();
    const updater = createDockBadgeUpdater({
      platform: 'darwin',
      getDueCount: () => 3,
      setBadge,
    });

    updater.refresh();

    expect(setBadge).toHaveBeenCalledTimes(1);
    expect(setBadge).toHaveBeenCalledWith('3');
  });

  it('clears the badge when nothing is due', () => {
    const setBadge = vi.fn();
    const updater = createDockBadgeUpdater({
      platform: 'darwin',
      getDueCount: () => 0,
      setBadge,
    });

    updater.refresh();

    expect(setBadge).toHaveBeenCalledTimes(1);
    expect(setBadge).toHaveBeenCalledWith('');
  });

  it('skips setBadge when the text has not changed since last refresh', () => {
    const setBadge = vi.fn();
    const updater = createDockBadgeUpdater({
      platform: 'darwin',
      getDueCount: () => 5,
      setBadge,
    });

    updater.refresh();
    updater.refresh();
    updater.refresh();

    expect(setBadge).toHaveBeenCalledTimes(1);
    expect(setBadge).toHaveBeenCalledWith('5');
  });

  it('pushes a new badge each time the count actually changes', () => {
    const setBadge = vi.fn();
    let count = 2;
    const updater = createDockBadgeUpdater({
      platform: 'darwin',
      getDueCount: () => count,
      setBadge,
    });

    updater.refresh();
    count = 0;
    updater.refresh();
    updater.refresh();
    count = 7;
    updater.refresh();

    expect(setBadge.mock.calls).toEqual([['2'], [''], ['7']]);
  });

  it('does nothing off darwin', () => {
    const setBadge = vi.fn();
    const getDueCount = vi.fn(() => 4);
    const updater = createDockBadgeUpdater({
      platform: 'linux',
      getDueCount,
      setBadge,
    });

    updater.refresh();

    expect(getDueCount).not.toHaveBeenCalled();
    expect(setBadge).not.toHaveBeenCalled();
  });
});
