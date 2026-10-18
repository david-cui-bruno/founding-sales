import { useState } from 'react';
import { CrmCapabilitiesSection } from './CrmCapabilitiesSection.tsx';
import { ExtractionSetup } from './ExtractionSetup.tsx';

/** Setup remains separate from the existing explicit capability approval controls. */
export function CrmOwnerSetup({ available, privacyKey }: { available: boolean; privacyKey: string }) {
  const [revision, setRevision] = useState(0);
  return <>
    <ExtractionSetup available={available} privacyKey={privacyKey} onSaved={() => setRevision(value => value + 1)} />
    <CrmCapabilitiesSection key={`${privacyKey}:${String(revision)}`} scope="ai" available={available} privacyKey={privacyKey} />
  </>;
}
