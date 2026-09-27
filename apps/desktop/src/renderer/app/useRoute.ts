import { useCallback, useEffect, useMemo, useState } from 'react';
import { routeOf, routeText, setNavigator, type Route } from '../routes.ts';
import { desktopBridge } from './bridges.ts';

/**
 * Where the window is, as React state (1.0.12).
 *
 * No router library: there is one window, seven places it can be, and the only things
 * that move it are the sidebar, the Window menu, a deep link and a view saying where its
 * own answer took it. A library would be a second vocabulary for that.
 *
 * Two ways in, and the difference matters.
 *
 * `navigate` is somebody asking for a view. It bumps `epoch`, and the column keys the
 * view on it, so asking for a view you are already on is a fresh look: the pipeline
 * re-read from a firm, Settings back at Administration from Diagnostics. Today is the
 * exception and is keyed on its name alone — its lanes may hold a half-typed snooze
 * reason, and ⌘1 must not throw that away.
 *
 * `routeShown` is a view reporting where its own answer put it: the CRM bridge opened a
 * firm from the board, the legacy Settings module switched its own tab. The route and
 * the sidebar follow, `epoch` does not move, and nothing is mounted again.
 */

interface RouteState {
  readonly route: Route;
  /** Bumped by `navigate` only. The column's key, so the same route again is a fresh view. */
  readonly epoch: number;
  navigate(next: Route): void;
}

/** The route in the address (`#firms`, `#firm/<id>`): a Reload comes back to the same view. */
function remember(next: Route): void {
  const hash = `#${routeText(next)}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

/**
 * The route a page was loaded on. The main process loads the window without a hash, so
 * the app opens on Today; the specs load one straight onto a route, and so does Reload.
 */
function initialRoute(): Route {
  return routeOf(decodeURIComponent(location.hash.slice(1))) ?? { name: 'today' };
}

export function useRoute(): RouteState {
  const [state, setState] = useState<{ readonly route: Route; readonly epoch: number }>(() => ({
    route: initialRoute(),
    epoch: 0,
  }));

  const navigate = useCallback((next: Route): void => {
    remember(next);
    setState(current => ({ route: next, epoch: current.epoch + 1 }));
  }, []);

  const routeShown = useCallback((next: Route): void => {
    setState(current => {
      if (routeText(next) === routeText(current.route)) return current;
      remember(next);
      return { route: next, epoch: current.epoch };
    });
  }, []);

  useEffect(() => {
    // The views reach the shell through `routes.ts` rather than through props: the
    // hand-rolled ones are modules, not components, and `navigate` is the one call they
    // have always made.
    setNavigator(navigate, routeShown);
  }, [navigate, routeShown]);

  useEffect(() => {
    // The Window menu's ⌘1–⌘4 and ⌘,, and a `callie://` link. The main process sends one
    // of the seven targets and nothing else; the preload has checked it before here.
    desktopBridge().onNavigate(target => {
      const next = routeOf(target);
      if (next !== null) navigate(next);
    });
  }, [navigate]);

  return useMemo(() => ({ route: state.route, epoch: state.epoch, navigate }), [state, navigate]);
}
