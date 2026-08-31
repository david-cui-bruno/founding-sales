import { useId } from 'react';
import type { ReactNode } from 'react';

export type PanelProps = {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
};

/** Labelled surface section with a heading and optional toolbar actions. */
export function Panel({ title, actions, children }: PanelProps) {
  const headingId = useId();

  return (
    <section className="panel" aria-labelledby={headingId}>
      <header className="panel__header">
        <h2 className="panel__title" id={headingId}>
          {title}
        </h2>
        {actions !== undefined && (
          <div className="panel__actions">{actions}</div>
        )}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
