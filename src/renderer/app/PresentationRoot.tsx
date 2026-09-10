import type { ReactNode } from 'react';
import { OverlayProvider } from './overlayLayers';

/** Stable presentation ownership, independent of route and workflow authority. */
export function PresentationRoot({ children }: { children: ReactNode }) {
  return <div className="presentation-root" data-presentation="native-a"><OverlayProvider>{children}</OverlayProvider></div>;
}
