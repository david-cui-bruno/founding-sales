// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSettingsSection } from './settingsNavigation';

const key = 'callie.settings.section';
afterEach(() => { vi.restoreAllMocks(); });
describe('Task8 navigation producer', () => {
  it.each(['connections', 'phone', 'worker', 'call-capacity'] as const)(
    'stores and dispatches exact string intent %s without replacing routing', section => {
      const prior = sessionStorage.getItem(key);
      const hash = location.hash;
      const href = location.href;
      const events: Event[] = [];
      const listener = (event: Event) => { events.push(event); };
      const stores: Storage[] = [];
      const originalSet = Storage.prototype.setItem;
      const local = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        stores.push(this); originalSet.call(this, key, value);
      });
      window.addEventListener('callie:open-settings-section', listener);
      try {
        openSettingsSection(section);
        expect(sessionStorage.getItem(key)).toBe(section);
        expect(local).toHaveBeenCalledWith(key, section);
        expect(stores).toEqual([sessionStorage]);
        expect(events).toHaveLength(1);
        const event = events[0];
        expect(event).toBeInstanceOf(CustomEvent);
        if (!(event instanceof CustomEvent)) throw Error('Expected CustomEvent');
        expect(event.detail).toBe(section);
        expect(location.hash).toBe(hash);
      } finally {
        window.removeEventListener('callie:open-settings-section', listener);
        local.mockRestore();
        window.history.replaceState(null, '', href);
        if (prior === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, prior);
      }
    }, 10_000,
  );
  it('still dispatches exact phone intent when session storage set fails', () => {
    const listener = vi.fn<(event: Event) => void>();
    const prior = sessionStorage.getItem(key);
    const hash = location.hash;
      const href = location.href;
    window.addEventListener('callie:open-settings-section', listener);
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('blocked storage'); });
    try {
      expect(() => openSettingsSection('phone')).not.toThrow();
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0];
      expect(event).toBeInstanceOf(CustomEvent);
      if (!(event instanceof CustomEvent)) throw Error('Expected CustomEvent');
      expect(event.detail).toBe('phone');
      expect(location.hash).toBe(hash);
    } finally {
      set.mockRestore();
      window.history.replaceState(null, '', href);
      window.removeEventListener('callie:open-settings-section', listener);
      if (prior === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, prior);
    }
  }, 10_000);
});
