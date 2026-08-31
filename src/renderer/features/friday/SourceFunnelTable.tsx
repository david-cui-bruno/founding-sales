import type { FridayReport } from '../../../shared/contracts/fridayContract';
import { EmptyState } from '../../components/EmptyState';

export type SourceFunnelTableProps = {
  rows: FridayReport['sourceRows'];
};

/**
 * Neutral counted funnel per source. Every number is a domain-provided count;
 * this table renders no rates.
 */
export function SourceFunnelTable({ rows }: SourceFunnelTableProps) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No funnel activity this week"
        description="Interviews, offers, and wins will appear by source."
      />
    );
  }

  return (
    <table className="friday-funnel">
      <thead>
        <tr>
          <th scope="col">Source</th>
          <th scope="col">Interviews</th>
          <th scope="col">Offers</th>
          <th scope="col">Wins</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.source}>
            <th scope="row">{row.source}</th>
            <td>{row.interviews}</td>
            <td>{row.offers}</td>
            <td>{row.wins}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
