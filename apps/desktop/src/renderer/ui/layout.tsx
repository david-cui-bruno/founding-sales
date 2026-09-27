import type { ComponentProps, JSX, ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { Alert } from './alert.tsx';

/**
 * The bones every view is built from (1.0.13).
 *
 * The column is one 860px measure with the same padding whoever draws it; a view is a
 * heading with its actions beside it, then sections separated by a rule and a small grey
 * label, then rows divided by hairlines with their actions on hover. Today and Replies
 * were written that way by hand in 1.0.12; these are the same shapes named once, so
 * Firms, Sequences and Settings are the same product rather than three of them.
 */

export function Page({ children, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div {...props} className={cn('mx-auto flex w-full max-w-[860px] flex-col px-12 pt-10 pb-20', props.className)}>
      {children}
    </div>
  );
}

export function ViewHeader({
  title,
  summary,
  actions,
  above,
}: {
  readonly title: string;
  readonly summary?: string | null;
  readonly actions?: ReactNode;
  /** A "← Pipeline" sort of link, above the heading. */
  readonly above?: ReactNode;
}): JSX.Element {
  return (
    <header data-testid="column-head" className="flex flex-col gap-1">
      {above}
      <div className="flex items-baseline justify-between gap-3">
        <h1 data-testid="heading" className="text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {summary === undefined || summary === null ? null : (
        <p data-testid="summary" className="text-sm text-muted-foreground">
          {summary}
        </p>
      )}
    </header>
  );
}

/** Every banner the view model asked for, in one place under the heading. */
export function Banners({ notices }: { readonly notices: readonly { readonly tone: 'info' | 'warning' | 'blocking'; readonly text: string }[] }): JSX.Element {
  return (
    <div data-testid="banners" className="mt-3 flex flex-col gap-2 empty:hidden">
      {notices.map(notice => (
        <Alert key={`${notice.tone}:${notice.text}`} tone={notice.tone} data-testid={`banner-${notice.tone}`}>
          {notice.text}
        </Alert>
      ))}
    </div>
  );
}

export function Section({
  title,
  count,
  actions,
  children,
  ...props
}: ComponentProps<'section'> & {
  readonly title: string;
  readonly count?: number;
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <section {...props} className={cn('mt-9', props.className)}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="flex items-baseline gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <span>{title}</span>
          {count === undefined ? null : <small className="text-[11px] font-normal">{count}</small>}
        </h2>
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A list of hairline-divided rows. */
export function Rows({ children, ...props }: ComponentProps<'ul'>): JSX.Element {
  return (
    <ul {...props} className={cn('flex flex-col border-t border-border', props.className)}>
      {children}
    </ul>
  );
}

/** One row: what it is on the left, what can be done to it on the right, on hover. */
export function Row({ children, ...props }: ComponentProps<'li'>): JSX.Element {
  return (
    <li {...props} className={cn('group flex items-center gap-3 border-b border-border py-1.5 last:border-b-0', props.className)}>
      {children}
    </li>
  );
}

/** The left of a row: a line, and a quieter line under it. */
export function RowMain({
  line,
  detail,
  lineTestId,
  detailTestId,
}: {
  readonly line: ReactNode;
  readonly detail?: ReactNode;
  readonly lineTestId?: string;
  readonly detailTestId?: string;
}): JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span data-testid={lineTestId} className="text-sm">
        {line}
      </span>
      {detail === undefined || detail === null ? null : (
        <span data-testid={detailTestId} className="text-xs text-muted-foreground">
          {detail}
        </span>
      )}
    </span>
  );
}

/** A row's actions: quiet until the row is under the pointer or something in it has focus. */
export function RowActions({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      {children}
    </span>
  );
}

/** A labelled control, with its hint and the sentence a refusal put under it. */
export function Field({
  label,
  htmlFor,
  hint,
  issues,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string | null;
  readonly issues?: readonly { readonly testId: string; readonly text: string }[];
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint === undefined || hint === null ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
      {(issues ?? []).map((issue, index) => (
        <p key={`${issue.testId}:${String(index)}`} data-testid={issue.testId} className="text-xs text-destructive">
          {issue.text}
        </p>
      ))}
    </div>
  );
}

/** The grey line a failed read leaves where a slice would have been, and Retry. */
export function Unread({
  line,
  testId,
  retryTestId,
  onRetry,
}: {
  readonly line: string;
  readonly testId: string;
  readonly retryTestId: string;
  onRetry(): void;
}): JSX.Element {
  return (
    <div className="mt-3 flex items-center gap-2">
      <p data-testid={testId} className="text-sm text-muted-foreground">
        {line}
      </p>
      <button
        type="button"
        data-testid={retryTestId}
        onClick={onRetry}
        className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        Retry
      </button>
    </div>
  );
}

/** A small grey word beside a row: a state, never a decoration. */
export function Tag({ children, tone = 'none', ...props }: ComponentProps<'span'> & { readonly tone?: 'ok' | 'warn' | 'none' }): JSX.Element {
  return (
    <span
      {...props}
      className={cn(
        'shrink-0 rounded px-1.5 py-px text-[11px] whitespace-nowrap',
        tone === 'ok'
          ? 'bg-[color-mix(in_oklch,var(--status-ok)_14%,white)] text-[color-mix(in_oklch,var(--status-ok)_70%,black)]'
          : tone === 'warn'
            ? 'bg-[color-mix(in_oklch,var(--status-warn)_16%,white)] text-[color-mix(in_oklch,var(--status-warn)_70%,black)]'
            : 'bg-muted text-muted-foreground',
        props.className,
      )}
    >
      {children}
    </span>
  );
}
