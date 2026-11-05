import type { JSX, ReactNode } from 'react';

/** Presentation only; product callers retain authority, requests and private state. */
export function WorkspaceNotice({ children, action, warning = false }: {
  children: ReactNode; action?: ReactNode; warning?: boolean;
}): JSX.Element {
  return <div className={`workspace-state${warning ? ' workspace-state-warning' : ''}`} role="status"><span>{children}</span>{action}</div>;
}

export function WorkspaceEmptyState({ title, children, action }: {
  title: string; children?: ReactNode; action?: ReactNode;
}): JSX.Element {
  return <div className="workspace-empty"><h2>{title}</h2>{children ? <div className="workspace-muted">{children}</div> : null}{action ? <div className="workspace-inline-actions">{action}</div> : null}</div>;
}

export function WorkspaceListDetail({ list, children, detailOpen, onBack, listLabel, detailLabel, backLabel = 'Back to list' }: {
  list: ReactNode; children: ReactNode; detailOpen: boolean; onBack: () => void;
  listLabel: string; detailLabel: string; backLabel?: string;
}): JSX.Element {
  return <div className="workspace-split" data-detail-open={detailOpen}>
    <aside className="workspace-list-pane" aria-label={listLabel}>{list}</aside>
    <section className="workspace-detail-pane" aria-label={detailLabel}>
      <div className="workspace-detail-content">{detailOpen ? <button type="button" className="workspace-back workspace-mobile-back" onClick={onBack}>← {backLabel}</button> : null}{children}</div>
    </section>
  </div>;
}
