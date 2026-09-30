import { useEffect, useId, useRef, type JSX, type ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

/**
 * A modal dialog in shadcn's shape (overlay, a bordered panel, a title, a footer).
 *
 * Built on the platform rather than on Radix, as `select` is (see README.md): the page
 * has no other dialog, and a fixed overlay with `role="dialog"`, `aria-modal`, Escape to
 * close and focus moved inside is everything one confirmation needs. A click on the
 * dimmed area closes it; a click in the panel does not.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  ...props
}: {
  readonly open: boolean;
  readonly title: string;
  onClose(): void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly 'data-testid'?: string;
}): JSX.Element | null {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    const first = panel.current?.querySelector<HTMLElement>('input, button, [tabindex]');
    first?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (before instanceof HTMLElement) before.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 px-4 pt-[12vh]"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={props['data-testid']}
        className={cn('flex w-full max-w-[460px] flex-col rounded-lg border border-border bg-background shadow-lg')}
      >
        <h2 id={titleId} className="px-5 pt-4 pb-3 text-base font-semibold tracking-tight">
          {title}
        </h2>
        <div className="flex flex-col border-t border-border px-5 py-3 text-sm">{children}</div>
        {footer === undefined ? null : (
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
