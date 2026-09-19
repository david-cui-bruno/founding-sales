import { TodayPage as TodayLanes } from '../today/TodayPage';

/** The Today route (slice S1): the four-lane morning list from `GET /v1/today`, read through `window.callie`. */
export function TodayPage({ onStatusChanged }: { onStatusChanged: () => Promise<void> }) {
  return <TodayLanes api={window.callie} onStatusChanged={onStatusChanged} />;
}
