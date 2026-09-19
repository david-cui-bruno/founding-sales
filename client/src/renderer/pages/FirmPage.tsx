import { FirmPage as FirmView } from '../today/FirmPage';

/** The Firm route (slice S2): one firm in full from `GET /v1/firms`, read through `window.callie`. */
export function FirmPage({ firmId, onBack, onStatusChanged }: { firmId: string; onBack: () => void; onStatusChanged: () => Promise<void> }) {
  return <FirmView api={window.callie} firmId={firmId} onBack={onBack} onStatusChanged={onStatusChanged} />;
}
