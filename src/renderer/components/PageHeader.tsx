import type { ReactNode } from 'react';

export type PageHeaderProps = {
  title: string;
  /** Live entity count rendered muted next to the title, e.g. "· 354 people". */
  count?: string;
  /** Accent CTA slot, rendered at the trailing edge. */
  primaryAction?: ReactNode;
  /** Search / filter controls slot. */
  children?: ReactNode;
  /** View switcher slot, rendered between children and the primary action. */
  trailing?: ReactNode;
};

/**
 * The per-route page header: one 20/26 600 title with an optional muted
 * count, then the route's own search/filter/view controls, then the single
 * accent primary action. Routes render exactly one of these, so screens
 * never carry a second H1.
 */
export function PageHeader({
  title,
  count,
  primaryAction,
  children,
  trailing,
}: PageHeaderProps) {
  return (
    <header className="page-header">
      <h1 className="page-header__title">
        {title}
        {count !== undefined && (
          <span className="page-header__count numeric">{` · ${count}`}</span>
        )}
      </h1>
      {children !== undefined && (
        <div className="page-header__controls">{children}</div>
      )}
      {trailing !== undefined && (
        <div className="page-header__trailing">{trailing}</div>
      )}
      {primaryAction !== undefined && (
        <div className="page-header__action">{primaryAction}</div>
      )}
    </header>
  );
}
