import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useCallback, useContext } from 'react';
import type { PreparedBriefDto } from '@fss/contracts';
import type { CrmState } from '../firmWorkspaceContract.ts';
import type { TodayState } from '../todayContract.ts';

/**
 * Lane PB, design reset I2: a saved or cleared prepared brief, applied as a pure state patch
 * to every cached view state that holds THAT firm — the firm page or panel (`crm`) and Today's
 * open card (`today`). Nothing is read and nothing is opened, so a save that answers while
 * David is on his way to another firm cannot bring the first one back; a view holding some
 * other firm is left exactly as it is.
 *
 * The main process patches its own snapshots in the same way (`operationHost.ts`), so the
 * next read of either view agrees with what is on screen.
 */

export function patchCrmState(state: CrmState | null | undefined, firmId: string, brief: PreparedBriefDto | null): CrmState | null | undefined {
  const firm = state?.firm;
  if (state == null || firm == null || firm.visibility !== 'assigned_or_admin' || firm.read.firm.id !== firmId) return state;
  return { ...state, firm: { ...firm, preparedBrief: brief } };
}

export function patchTodayState(state: TodayState | null | undefined, firmId: string, brief: PreparedBriefDto | null): TodayState | null | undefined {
  const expanded = state?.expanded;
  if (state == null || expanded == null || expanded.firmId !== firmId) return state;
  return { ...state, expanded: { ...expanded, preparedBrief: brief } };
}

export function patchPreparedBrief(client: QueryClient, firmId: string, brief: PreparedBriefDto | null): void {
  client.setQueriesData<CrmState | null>({ queryKey: ['crm'] }, state => patchCrmState(state, firmId, brief) ?? undefined);
  client.setQueriesData<TodayState | null>({ queryKey: ['today'] }, state => patchTodayState(state, firmId, brief) ?? undefined);
}

/** The patch, bound to the window's request cache; a view drawn without one patches nothing. */
export function usePatchPreparedBrief(): (firmId: string, brief: PreparedBriefDto | null) => void {
  const client = useContext(QueryClientContext);
  return useCallback(
    (firmId: string, brief: PreparedBriefDto | null): void => {
      if (client !== undefined) patchPreparedBrief(client, firmId, brief);
    },
    [client],
  );
}
