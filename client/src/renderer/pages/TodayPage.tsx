import { TodayPage as TodayLanes } from '../today/TodayPage';

/**
 * The Today route (slice S1): the four-lane morning list from `GET /v1/today`, read through `window.callie`.
 * Slice S2 adds the Phone.app handoff, the outcome form, the add-a-firm form and the way through to one firm's page.
 */
export function TodayPage({ onStatusChanged, onOpenFirm }: { onStatusChanged: () => Promise<void>; onOpenFirm: (firmId: string) => void }) {
  return <TodayLanes api={window.callie} onStatusChanged={onStatusChanged} onOpenFirm={onOpenFirm} />;
}
