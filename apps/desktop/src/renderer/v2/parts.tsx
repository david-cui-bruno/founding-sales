import { AlertTriangle, Check, CircleDashed, Loader2, Pencil, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ComponentProps, type JSX, type ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';

/**
 * The v2 building blocks, composed from the owned shadcn primitives in `src/renderer/ui`.
 * Nothing here replaces a primitive: a v2 button is `<Button>` with the v2 density passed
 * through `className`, and its colours come from the tokens.
 */

/** A keyboard hint. */
export function Kbd({ children, className }: { readonly children: ReactNode; readonly className?: string }): JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-border bg-background px-1 font-sans text-2xs font-medium text-faint',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** A small grey label above a group: sentence case, never shouting. */
export function Label({ children, actions, className }: { readonly children: ReactNode; readonly actions?: ReactNode; readonly className?: string }): JSX.Element {
  return (
    <div className={cn('mb-1.5 flex items-center justify-between gap-2', className)}>
      <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>
      {actions}
    </div>
  );
}

/** A group inside a panel, separated from the one above by a hairline. */
export function Block({ children, className, ...props }: ComponentProps<'section'>): JSX.Element {
  return (
    <section {...props} className={cn('border-t border-border py-4 first:border-t-0 first:pt-0', className)}>
      {children}
    </section>
  );
}

export type ChipTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'outline';

const CHIP_TONE: Readonly<Record<ChipTone, string>> = {
  neutral: 'bg-muted text-muted-foreground',
  ok: 'bg-ok-soft text-ok-ink',
  warn: 'bg-warn-soft text-warn-ink',
  danger: 'bg-danger-soft text-danger-ink',
  info: 'bg-info-soft text-info-ink',
  outline: 'border border-border text-muted-foreground',
};

export function Chip({
  tone = 'neutral',
  icon,
  children,
  className,
  ...props
}: ComponentProps<'span'> & { readonly tone?: ChipTone; readonly icon?: ReactNode }): JSX.Element {
  return (
    <span
      {...props}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3',
        CHIP_TONE[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** `skipped` (Slice 2): a step that does not apply — a call nobody answered has no recording. */
export type Progress = 'waiting' | 'pending' | 'done' | 'failed' | 'skipped';

/**
 * One post-call step's state: a chip that changes in place, with words as well as colour.
 * `word` replaces the default word when the state needs a more exact one ("too short").
 */
export function StepChip({
  label,
  state,
  word,
  testId,
}: {
  readonly label: string;
  readonly state: Progress;
  readonly word?: string;
  readonly testId?: string;
}): JSX.Element {
  const tone: ChipTone = state === 'done' ? 'ok' : state === 'failed' ? 'danger' : state === 'pending' ? 'info' : state === 'skipped' ? 'neutral' : 'outline';
  const icon =
    state === 'done' ? <Check /> : state === 'failed' ? <AlertTriangle /> : state === 'pending' ? <Loader2 className="animate-spin" /> : <CircleDashed />;
  const fallback =
    state === 'done' ? 'done' : state === 'failed' ? 'failed' : state === 'pending' ? 'in progress' : state === 'skipped' ? 'none' : 'waiting';
  return (
    <Chip tone={tone} icon={icon} data-testid={testId} data-state={state} aria-live="polite">
      {label} {word ?? fallback}
    </Chip>
  );
}

/** The provenance of a fact: verified (with its source), a labelled hypothesis, or unknown. */
export function Provenance({ kind, source }: { readonly kind: 'verified' | 'hypothesis' | 'unknown'; readonly source?: string }): JSX.Element {
  if (kind === 'verified') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3 shrink-0 text-ok-ink" aria-hidden />
        <span className="sr-only">Verified:</span>
        <span className="truncate">{source}</span>
      </span>
    );
  }
  if (kind === 'hypothesis') return <Chip tone="info">Hypothesis</Chip>;
  return <Chip tone="warn">Unknown</Chip>;
}

/**
 * A property row with an inline-edit affordance: grey label, value, and on hover a light
 * well and a pencil. Click, Enter or `E` (when it is the focused row) opens the field in
 * place; Enter saves and Escape cancels. A missing value says what to add.
 */
export function PropertyRow({
  label,
  value,
  missing,
  editing: editingInitially = false,
  onEdit,
  mono,
  testId,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly missing?: string;
  readonly editing?: boolean;
  onEdit?(next: string): void;
  readonly mono?: boolean;
  readonly testId?: string;
}): JSX.Element {
  const [editing, setEditing] = useState(editingInitially);
  const [draft, setDraft] = useState(value ?? '');
  const [shown, setShown] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const save = (): void => {
    const next = draft.trim();
    setShown(next === '' ? null : next);
    onEdit?.(next);
    setEditing(false);
  };
  return (
    <div data-testid={testId} className="grid min-h-[var(--v2-row)] grid-cols-[112px_minmax(0,1fr)] items-center gap-2">
      <label htmlFor={id} className="truncate text-sm text-muted-foreground">
        {label}
      </label>
      {editing ? (
        <div className="flex items-center gap-1">
          <Input
            ref={input}
            id={id}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') save();
              if (event.key === 'Escape') {
                setDraft(shown ?? '');
                setEditing(false);
              }
            }}
            placeholder={missing}
            className="h-7 border-strong px-2 text-sm"
          />
          <Button size="icon" variant="ghost" className="size-7" aria-label={`Save ${label}`} onClick={save}>
            <Check />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Cancel"
            onClick={() => {
              setDraft(shown ?? '');
              setEditing(false);
            }}
          >
            <X />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          id={id}
          data-property={label}
          onClick={() => setEditing(true)}
          className="group/prop -mx-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-muted"
        >
          {shown === null ? (
            <span className="flex items-center gap-1.5 text-faint">
              <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
              {missing ?? 'Empty'}
            </span>
          ) : (
            <span className={cn('min-w-0 truncate', mono && 'font-mono text-[12.5px] tabular')}>{shown}</span>
          )}
          <Pencil className="ml-auto size-3 shrink-0 text-faint opacity-0 transition-opacity group-hover/prop:opacity-100 group-focus-visible/prop:opacity-100" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** A grey shimmer bar standing in for text that has not arrived. */
export function Skeleton({ className }: { readonly className?: string }): JSX.Element {
  return <span aria-hidden className={cn('block h-3 animate-pulse rounded-sm bg-muted', className)} />;
}

/** A quiet centred message: empty or failed. */
export function EmptyState({
  icon,
  title,
  children,
  actions,
  className,
  testId,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}): JSX.Element {
  return (
    <div data-testid={testId} className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon === undefined ? null : <span className="mb-1 text-faint [&_svg]:size-5">{icon}</span>}
      <p className="text-sm font-medium">{title}</p>
      {children === undefined ? null : <div className="max-w-[300px] text-sm text-muted-foreground">{children}</div>}
      {actions === undefined ? null : <div className="mt-2 flex gap-2">{actions}</div>}
    </div>
  );
}

/** The v2 button densities, applied to the shadcn Button. */
export const dense = {
  sm: 'h-6 rounded-md px-2 text-xs',
  md: 'h-7 rounded-md px-2.5 text-sm',
  lg: 'h-9 rounded-md px-3.5 text-sm',
  icon: 'size-7 rounded-md',
} as const;

/**
 * A titled group in a page or panel (S4): a sentence-case grey label with an optional count and
 * actions, then its content. Where the older `Section` shouts in capitals, this reads like the
 * rest of the v2 views. The props are `Section`'s, so a view swaps one for the other.
 */
export function Group({
  title,
  count,
  actions,
  children,
  className,
  ...props
}: Omit<ComponentProps<'section'>, 'title'> & {
  readonly title: string;
  readonly count?: number;
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <section {...props} className={cn('mt-7 first:mt-0', className)}>
      <div className="mb-1.5 flex min-h-6 items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-1.5 text-xs font-medium text-muted-foreground">
          <span>{title}</span>
          {count === undefined ? null : <small className="font-normal text-faint tabular-nums">{count}</small>}
        </h2>
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
