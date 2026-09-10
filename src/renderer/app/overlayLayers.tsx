import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';

export type DismissReason = 'escape' | 'cancel' | 'close-button' | 'backdrop' | 'command';
export type DismissibleLayerOptions = {
  open: boolean;
  kind: 'modal' | 'nonmodal';
  elementRef: RefObject<HTMLElement | null>;
  canDismiss(): boolean;
  onDismiss(reason: DismissReason): void;
  returnFocus?: () => HTMLElement | null;
};
type Layer = {
  token: symbol;
  kind: DismissibleLayerOptions['kind'];
  element: HTMLElement;
  opener: HTMLElement | null;
  returnFocus(): HTMLElement | null;
  order: number;
  dismiss(reason: DismissReason): boolean;
};

/** Reject hidden/inert ancestors, including collapsed secondary navigation. */
function visible(element: HTMLElement | null): boolean {
  if (!element?.isConnected || element.closest('[inert], [hidden], [aria-hidden="true"], dialog:not([open])')) return false;
  if (element === document.body || element.matches(':disabled')) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}
function safeControl(element?: HTMLElement) {
  return Array.from(element?.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]') ?? [])
    .find((node) => visible(node) && node.tabIndex >= 0) ?? null;
}
function createLayers() {
  const layers: Layer[] = [];
  let order = 0;
  let lastFocus: HTMLElement | null = null;
  // A React commit closes the outgoing native dialog before opening its
  // replacement. Retain origins only until this turn's cleanup microtask.
  type Handoff = { retired: Layer[]; candidate?: { entry: Layer; parentToken?: symbol } };
  let handoff: Handoff | null = null;
  const originOf = (entry: Layer, retired: Layer[]): HTMLElement | null => {
    let origin = entry.returnFocus() ?? entry.opener;
    const visited = new Set<Layer>([entry]);
    // Parent and child can both close in one commit, in either cleanup order.
    while (origin) {
      const parent = retired.find((item) => !visited.has(item) && item.element.contains(origin));
      if (!parent) break;
      visited.add(parent);
      origin = parent.returnFocus() ?? parent.opener;
    }
    return origin;
  };
  const top = () => [...layers].reverse().find((layer) => layer.kind === 'modal') ?? layers.at(-1);
  return {
    top,
    hasOpenLayer: () => layers.length > 0,
    hasModal: () => layers.some((layer) => layer.kind === 'modal'),
    focus: (element: HTMLElement) => { lastFocus = element; },
    register(layer: Omit<Layer, 'order'>) {
      const candidate = handoff?.candidate;
      const replacing = layer.kind === 'modal' && candidate && candidate.parentToken === top()?.token;
      const inherited = replacing ? originOf(candidate.entry, handoff.retired) : null;
      const entry = { ...layer, opener: layer.returnFocus() ?? inherited ?? layer.opener, order: ++order };
      if (replacing) handoff.candidate = undefined;
      layers.push(entry);
      return () => {
        const active = document.activeElement;
        const focused = active === document.body ? lastFocus : active;
        const restore = entry.kind === 'modal' || (focused instanceof Node && entry.element.contains(focused));
        const wasTop = top() === entry;
        layers.splice(layers.indexOf(entry), 1);
        const turn = handoff ?? (handoff = { retired: [] });
        turn.retired.push(entry);
        if (wasTop && entry.kind === 'modal') turn.candidate = { entry, parentToken: top()?.token };
        queueMicrotask(() => {
          if (handoff === turn) handoff = null;
          // StrictMode replay or replacement/child modal owns focus now.
          if (!restore || layers.some((item) => item.token === entry.token) ||
            layers.some((item) => item.kind === 'modal' && item.order > entry.order)) return;
          const origin = originOf(entry, turn.retired);
          const opener = visible(origin) ? origin : origin?.id ? document.getElementById(origin.id) : null;
          const parent = top();
          const activeRoute = document.querySelector<HTMLElement>('nav[aria-label="Primary"] a[aria-current="page"]');
          const more = document.querySelector<HTMLElement>('nav[aria-label="Primary"] button[aria-expanded]');
          const candidates = [opener, safeControl(parent?.element), activeRoute, more, document.getElementById('main-content')];
          candidates.find((candidate) => visible(candidate) &&
            (parent?.kind !== 'modal' || parent.element.contains(candidate)))?.focus();
        });
      };
    },
  };
}
type Layers = ReturnType<typeof createLayers>;
const OverlayContext = createContext<Layers | null>(null);
function useLayers() {
  const value = useContext(OverlayContext);
  if (!value) throw new Error('Overlay consumers require PresentationRoot or OverlayProvider');
  return value;
}
export function OverlayProvider({ children }: { children: ReactNode }) {
  const layers = useMemo(createLayers, []);
  useLayoutEffect(() => {
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) layers.focus(event.target);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const top = layers.top();
      if (!top) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.isComposing && !event.repeat) top.dismiss('escape');
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocus);
    };
  }, [layers]);
  return <OverlayContext.Provider value={layers}>{children}</OverlayContext.Provider>;
}
export function useOverlayLayers(): Pick<Layers, 'hasOpenLayer' | 'hasModal'> {
  return useLayers();
}
export function useDismissibleLayer(options: DismissibleLayerOptions) {
  const layers = useLayers();
  const latest = useRef(options);
  latest.current = options;
  const token = useRef(Symbol('overlay'));
  const dismissed = useRef(false);
  const isTopmost = useCallback(() => layers.top()?.token === token.current, [layers]);
  const requestDismiss = useCallback((reason: DismissReason) => {
    if (!isTopmost() || dismissed.current || !latest.current.canDismiss()) return false;
    dismissed.current = true;
    latest.current.onDismiss(reason);
    return true;
  }, [isTopmost]);
  const { open, kind, elementRef } = options;
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!open || !element) return;
    dismissed.current = false;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const opener = latest.current.returnFocus?.() ?? active;
    return layers.register({ token: token.current, kind, element, opener, returnFocus: () => latest.current.returnFocus?.() ?? null, dismiss: requestDismiss });
  }, [open, kind, elementRef, layers, requestDismiss]);
  return { requestDismiss, isTopmost };
}
