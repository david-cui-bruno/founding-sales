import type { PropertySummary } from '../../../shared/contracts/leadDetailContract';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';

export type InspectorPropertiesProps = {
  properties: PropertySummary[];
};

/** Property evidence: addresses, doors, ownership proof, live vacancies. */
export function InspectorProperties({ properties }: InspectorPropertiesProps) {
  if (properties.length === 0) {
    return (
      <EmptyState
        title="No linked properties"
        description="Properties tied to this owner will appear here."
      />
    );
  }

  return (
    <ul className="lead-inspector__properties">
      {properties.map((property) => (
        <li key={property.id} className="lead-inspector__property">
          <p className="lead-inspector__timeline-summary">{property.address}</p>
          <p className="lead-inspector__timeline-meta">
            {property.doors !== null && <span>{property.doors} doors · </span>}
            {property.ownershipEvidence !== null && (
              <span>{property.ownershipEvidence}</span>
            )}
            {property.ownershipEvidence === null && (
              <span>Ownership unverified</span>
            )}
          </p>
          {property.liveVacancy && (
            <StatusPill tone="urgent">live vacancy</StatusPill>
          )}
        </li>
      ))}
    </ul>
  );
}
