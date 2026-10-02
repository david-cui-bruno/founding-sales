/**
 * Where the window opens, and how it remembers (2 Oct 2026: "when i open the callie app,
 * i want it to take up most of my screen").
 *
 * Everything here is pure: given what was saved, the connected displays and the minimum
 * size, `chooseWindowBounds` says where the window goes. It knows nothing about Electron,
 * so it is tested without it; `windowStateWiring.ts` is the thin layer that reads the
 * screen, listens to the window and writes the file.
 */

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayArea {
  /** The part of the display the window may use (below the menu bar, above the Dock). */
  readonly workArea: Rectangle;
}

export interface SavedWindowState {
  readonly bounds: Rectangle;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

export interface ChosenWindow {
  readonly bounds: Rectangle;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

export const DEFAULT_FRACTION = 0.9;
/** Less than this share of the window on any one display counts as off-screen. */
export const MIN_VISIBLE_SHARE = 0.5;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Reads the saved file's text. Anything unusable is `null`, never a throw. */
export function parseWindowState(text: string | null): SavedWindowState | null {
  if (text === null) return null;
  interface Raw {
    bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    maximized?: unknown;
    fullScreen?: unknown;
  }
  let raw: Raw | null;
  try {
    raw = JSON.parse(text) as Raw | null;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw;
  const b = record.bounds;
  if (typeof b !== 'object' || b === null) return null;
  if (!isFiniteNumber(b.x) || !isFiniteNumber(b.y) || !isFiniteNumber(b.width) || !isFiniteNumber(b.height)) return null;
  if (b.width <= 0 || b.height <= 0) return null;
  return {
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
    maximized: record.maximized === true,
    fullScreen: record.fullScreen === true,
  };
}

function overlapArea(a: Rectangle, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function fitTo(bounds: Rectangle, area: Rectangle, minimum: { width: number; height: number }): Rectangle {
  const width = Math.min(Math.max(bounds.width, minimum.width), area.width);
  const height = Math.min(Math.max(bounds.height, minimum.height), area.height);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** About 90% of the work area, centred. */
export function defaultBounds(area: Rectangle, minimum: { width: number; height: number }): Rectangle {
  const width = Math.max(minimum.width, Math.round(area.width * DEFAULT_FRACTION));
  const height = Math.max(minimum.height, Math.round(area.height * DEFAULT_FRACTION));
  return fitTo(
    { x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height },
    area,
    minimum,
  );
}

/**
 * `preferred` is the display to use when there is nothing usable to restore: the one
 * under the cursor, or the primary. A saved window is restored only if most of it is
 * visible on some connected display; then it is clamped to that display's work area.
 */
export function chooseWindowBounds(input: {
  readonly saved: SavedWindowState | null;
  readonly displays: readonly DisplayArea[];
  readonly preferred: DisplayArea;
  readonly minimum: { readonly width: number; readonly height: number };
}): ChosenWindow {
  const { saved, displays, preferred, minimum } = input;
  if (saved !== null) {
    const windowArea = saved.bounds.width * saved.bounds.height;
    let best: DisplayArea | null = null;
    let bestOverlap = 0;
    for (const display of displays) {
      const overlap = overlapArea(saved.bounds, display.workArea);
      if (overlap > bestOverlap) {
        best = display;
        bestOverlap = overlap;
      }
    }
    if (best !== null && bestOverlap >= windowArea * MIN_VISIBLE_SHARE) {
      return {
        bounds: fitTo(saved.bounds, best.workArea, minimum),
        maximized: saved.maximized,
        fullScreen: saved.fullScreen,
      };
    }
  }
  return { bounds: defaultBounds(preferred.workArea, minimum), maximized: false, fullScreen: false };
}
