import type { ReactNode } from 'react';

/** Stable presentation ownership, independent of route and workflow authority. */
export function PresentationRoot({ children }: { children: ReactNode }) {
  return <div className="presentation-root" data-presentation="native-a">{children}</div>;
}
