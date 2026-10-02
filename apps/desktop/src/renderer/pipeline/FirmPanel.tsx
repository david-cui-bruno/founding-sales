import { ArrowUpRight, X } from 'lucide-react';
import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { dense } from '../v2/parts.tsx';

/**
 * The Pipeline's side panel (S4): a firm's context beside the board, so opening a card does
 * not move the board. The scroll offset is kept by the caller (`memory`) and put back before
 * the first paint, so the panel is where it was left after a visit to Today.
 */
export function FirmPanel({
  name,
  children,
  scroll,
  onScroll,
  onOpenFull,
  onClose,
}: {
  readonly name: string;
  readonly children: ReactNode;
  /** The offset to start at, and the callback that keeps it. */
  readonly scroll: number;
  onScroll(offset: number): void;
  onOpenFull(): void;
  onClose(): void;
}): JSX.Element {
  const body = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (body.current !== null) body.current.scrollTop = scroll;
    // Once per mount: the person's own scrolling is not fought by a later read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <aside
      data-testid="firm-panel"
      data-region="panel"
      aria-label="Firm"
      className={cn('callie-v2 flex w-[400px] shrink-0 flex-col border-l border-border bg-background shadow-lg min-[1920px]:w-[480px]')}
    >
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
        <span data-testid="firm-panel-name" className="min-w-0 flex-1 truncate px-1 text-sm font-semibold" title={name}>
          {name}
        </span>
        <Button
          variant="ghost"
          data-testid="firm-panel-full"
          className={cn(dense.icon, 'text-muted-foreground')}
          aria-label="Open firm page"
          title="Open firm page"
          onClick={onOpenFull}
        >
          <ArrowUpRight />
        </Button>
        <Button
          variant="ghost"
          data-testid="firm-panel-close"
          className={cn(dense.icon, 'text-muted-foreground')}
          aria-label="Close panel"
          title="Close (Esc)"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div
        ref={body}
        data-testid="firm-panel-scroll"
        className="min-h-0 flex-1 overflow-y-auto p-5"
        onScroll={event => {
          onScroll(event.currentTarget.scrollTop);
        }}
      >
        {children}
      </div>
    </aside>
  );
}
