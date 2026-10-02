import { describe, expect, it } from 'vitest';
import { chooseWindowBounds, parseWindowState, type DisplayArea } from '../src/main/windowState.ts';

const minimum = { width: 760, height: 480 };
const laptop: DisplayArea = { workArea: { x: 0, y: 25, width: 1440, height: 800 } };
const big: DisplayArea = { workArea: { x: 0, y: 25, width: 2560, height: 1340 } };
const external: DisplayArea = { workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };

const saved = (x: number, y: number, width: number, height: number, extra = {}) =>
  JSON.stringify({ bounds: { x, y, width, height }, maximized: false, fullScreen: false, ...extra });

describe('the window’s first size and the one it remembers', () => {
  it('opens at 90% of a 1440x900 screen, centred', () => {
    const r = chooseWindowBounds({ saved: null, displays: [laptop], preferred: laptop, minimum });
    expect(r.bounds).toEqual({ x: 72, y: 65, width: 1296, height: 720 });
    expect(r.maximized).toBe(false);
  });

  it('opens at 90% of a 2560x1440 screen, centred', () => {
    const r = chooseWindowBounds({ saved: null, displays: [big], preferred: big, minimum });
    expect(r.bounds).toEqual({ x: 128, y: 92, width: 2304, height: 1206 });
  });

  it('restores what was saved', () => {
    const r = chooseWindowBounds({ saved: parseWindowState(saved(100, 100, 900, 600)), displays: [laptop], preferred: laptop, minimum });
    expect(r.bounds).toEqual({ x: 100, y: 100, width: 900, height: 600 });
  });

  it('restores on a second display', () => {
    const r = chooseWindowBounds({ saved: parseWindowState(saved(1600, 100, 900, 600)), displays: [laptop, external], preferred: laptop, minimum });
    expect(r.bounds).toEqual({ x: 1600, y: 100, width: 900, height: 600 });
  });

  it('falls back to the default on the nearest display when the saved display is gone', () => {
    // Saved on the external monitor; only the laptop is connected now.
    const r = chooseWindowBounds({ saved: parseWindowState(saved(1600, 100, 900, 600)), displays: [laptop], preferred: laptop, minimum });
    expect(r.bounds).toEqual({ x: 72, y: 65, width: 1296, height: 720 });
    expect(r.maximized).toBe(false);
  });

  it('falls back when only a sliver of the saved window is still on a connected display', () => {
    // 140 of its 900 columns overlap the laptop; the rest was on the unplugged monitor.
    const r = chooseWindowBounds({ saved: parseWindowState(saved(1300, 100, 900, 600)), displays: [laptop], preferred: laptop, minimum });
    expect(r.bounds).toEqual({ x: 72, y: 65, width: 1296, height: 720 });
  });

  it('clamps a too-small saved size to the minimum', () => {
    const r = chooseWindowBounds({ saved: parseWindowState(saved(100, 100, 200, 100)), displays: [laptop], preferred: laptop, minimum });
    expect(r.bounds).toEqual({ x: 100, y: 100, width: 760, height: 480 });
  });

  it('clamps a window larger than the work area, and one hanging off the edge', () => {
    const r = chooseWindowBounds({ saved: parseWindowState(saved(0, 25, 1600, 1000)), displays: [laptop], preferred: laptop, minimum });
    expect(r.bounds).toEqual({ x: 0, y: 25, width: 1440, height: 800 });
    const edge = chooseWindowBounds({ saved: parseWindowState(saved(800, 300, 900, 600)), displays: [laptop], preferred: laptop, minimum });
    expect(edge.bounds).toEqual({ x: 540, y: 225, width: 900, height: 600 });
  });

  it('falls back on a corrupt, empty or wrong-shaped file', () => {
    for (const text of ['{not json', '', 'null', '[]', '{"bounds":{"x":"a"}}', '{"bounds":{"x":0,"y":0,"width":-5,"height":10}}', null]) {
      expect(parseWindowState(text)).toBeNull();
      const r = chooseWindowBounds({ saved: parseWindowState(text), displays: [laptop], preferred: laptop, minimum });
      expect(r.bounds).toEqual({ x: 72, y: 65, width: 1296, height: 720 });
    }
  });

  it('restores maximized and full-screen', () => {
    const m = chooseWindowBounds({ saved: parseWindowState(saved(100, 100, 900, 600, { maximized: true })), displays: [laptop], preferred: laptop, minimum });
    expect(m.maximized).toBe(true);
    expect(m.bounds).toEqual({ x: 100, y: 100, width: 900, height: 600 });
    const f = chooseWindowBounds({ saved: parseWindowState(saved(100, 100, 900, 600, { fullScreen: true })), displays: [laptop], preferred: laptop, minimum });
    expect(f.fullScreen).toBe(true);
  });
});
