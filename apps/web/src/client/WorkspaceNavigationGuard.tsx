import { createContext, useCallback, useContext, useEffect, useState, type JSX, type ReactNode } from 'react';

type LeaveGuard = () => boolean;
const NavigationGuards = createContext<{blocks:Set<LeaveGuard>;editors:Set<LeaveGuard>} | null>(null);

/** Mounted editors own their guards; this boundary retains no draft or identity. */
export function WorkspaceNavigationGuard({ children }: { children: ReactNode }): JSX.Element {
  const [guards] = useState(() => ({blocks:new Set<LeaveGuard>(),editors:new Set<LeaveGuard>()}));
  return <NavigationGuards value={guards}>{children}</NavigationGuards>;
}

export function useWorkspaceNavigation(): LeaveGuard {
  const guards = useContext(NavigationGuards);
  return useCallback(() => {
    for (const canLeave of guards?.blocks ?? []) if (!canLeave()) return false;
    for (const canLeave of guards?.editors ?? []) if (!canLeave()) return false;
    return true;
  }, [guards]);
}

/** Live or pending owners may refuse navigation without discarding their custody. */
export function useWorkspaceLeaveGuard(canLeave: LeaveGuard): void {
  const guards = useContext(NavigationGuards);
  useEffect(() => {
    guards?.blocks.add(canLeave);
    return () => { guards?.blocks.delete(canLeave); };
  }, [canLeave, guards]);
}

/** Confirm only edits without durable custody. Revocation never consults this guard. */
export function useUnsavedWorkspaceText(dirty: boolean): void {
  const guards = useContext(NavigationGuards);
  useEffect(() => {
    if (!dirty) return;
    const canLeave = (): boolean => window.confirm('Discard unsaved changes? Your saved work will not change.');
    const beforeUnload = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
    guards?.editors.add(canLeave);
    window.addEventListener('beforeunload', beforeUnload);
    return () => { guards?.editors.delete(canLeave); window.removeEventListener('beforeunload', beforeUnload); };
  }, [dirty, guards]);
}
