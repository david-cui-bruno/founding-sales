import { describe, expect, it } from 'vitest';
import { SHORTCUTS, shortcutFor, type KeyLike } from '../src/renderer/v2/shortcuts.ts';

/**
 * The Slice 1 prototype's two keyboard rules: no shortcut dials, and typing in a field
 * never navigates.
 */

const key = (k: string, target: KeyLike['target'] = { tagName: 'BODY' }, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target,
  ...mods,
});

describe('prototype shortcuts', () => {
  it('maps navigation, search, edit and help on the page', () => {
    expect(shortcutFor(key('j'))).toBe('next');
    expect(shortcutFor(key('ArrowUp'))).toBe('previous');
    expect(shortcutFor(key('/'))).toBe('search');
    expect(shortcutFor(key('e'))).toBe('edit');
    expect(shortcutFor(key('?'))).toBe('help');
    expect(shortcutFor(key('2', { tagName: 'BODY' }, { metaKey: true }))).toBe('pipeline');
  });

  it('has no action that starts a call, for any single key or ⌘ chord', () => {
    const actions = new Set<string>();
    for (let code = 32; code < 127; code += 1) {
      const k = String.fromCharCode(code);
      for (const mods of [{}, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
        const action = shortcutFor(key(k, { tagName: 'BODY' }, mods));
        if (action !== null) actions.add(action);
      }
    }
    for (const k of ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Escape']) {
      const action = shortcutFor(key(k));
      if (action !== null) actions.add(action);
    }
    expect([...actions].some(action => /call|dial/u.test(action))).toBe(false);
    expect(SHORTCUTS.some(shortcut => /call|dial/iu.test(shortcut.action))).toBe(false);
  });

  it('ignores navigation keys while typing in a field, a textarea, a select or editable text', () => {
    const fields: KeyLike['target'][] = [
      { tagName: 'INPUT', type: 'text' },
      { tagName: 'INPUT', type: 'search' },
      { tagName: 'TEXTAREA' },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ];
    for (const target of fields) {
      for (const k of ['j', 'k', 'e', '/', '?', 'ArrowDown', 'ArrowUp']) expect(shortcutFor(key(k, target))).toBeNull();
      expect(shortcutFor(key('1', target, { metaKey: true }))).toBeNull();
      // Leaving the field and opening search still work.
      expect(shortcutFor(key('Escape', target))).toBe('close');
      expect(shortcutFor(key('k', target, { metaKey: true }))).toBe('search');
    }
  });

  it('still navigates when focus is on a button or a checkbox', () => {
    expect(shortcutFor(key('j', { tagName: 'BUTTON' }))).toBe('next');
    expect(shortcutFor(key('j', { tagName: 'INPUT', type: 'checkbox' }))).toBe('next');
  });
});
