import { useEffect, useRef, type JSX } from 'react';
import type { Route, View } from '../routes.ts';

/**
 * A hand-rolled page module, mounted inside the React shell (1.0.12).
 *
 * Firms, Sequences and the three Settings tabs are still `mount(container, route)` /
 * `unmount()` modules drawing their own DOM. They work, they are tested, and rewriting
 * all of them in one release would be a release nobody could review — so the shell gives
 * each one a container and stays out of it. U2 converts them and deletes this file.
 *
 * Two things this adapter owes the module it hosts.
 *
 * **It unmounts.** React removing the container is not the same as the module being told
 * to stop: the module holds a reference to it, has calls in flight, and would draw into
 * a detached node when they answered. The cleanup calls `unmount` first and empties the
 * container afterwards, which is the order the shell used before React.
 *
 * **It does not remount on its own.** `mountKey` is the caller's, not the route's,
 * because the legacy Settings module chooses its own tab and rewrites the route as it
 * goes; remounting every time it did that would re-read the server and throw away what
 * somebody was editing. The caller says when a mount is a new mount.
 */
export function LegacyView({
  view,
  route,
  mountKey,
}: {
  readonly view: View;
  readonly route: Route;
  /** Changes exactly when this module should be mounted again. */
  readonly mountKey: string;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  // Read inside the effect, so a re-render with the same `mountKey` does not remount.
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    const container = host.current;
    if (container === null) return;
    view.mount(container, routeRef.current);
    return () => {
      view.unmount();
      container.replaceChildren();
    };
  }, [view, mountKey]);

  return <div ref={host} data-testid="legacy-view" className="contents" />;
}
