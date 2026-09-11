import type { LocalCommitmentsSnapshot } from '../../../shared/contracts/localWorkspaceContract';
import type { LocalRead } from './localWorkspaceRead';

export type VisibleCount =
  | { kind: 'known'; value: number }
  | { kind: 'unavailable' }
  | { kind: 'partial'; value: number }
  | { kind: 'last_known'; value: number }
  | { kind: 'checking'; value: number | null };

/** A pending refresh does not erase a previously observed source limitation. */
export function localCommitmentsCount(read?: LocalRead<LocalCommitmentsSnapshot>): VisibleCount {
  if (!read?.value) return read?.pending ? { kind: 'checking', value: null } : { kind: 'unavailable' };
  const value = read.value.items.length;
  if (read.error) return { kind: 'last_known', value };
  if (read.value.reviewErrorCount) return { kind: 'partial', value };
  return read.pending ? { kind: 'checking', value } : { kind: 'known', value };
}

export function formatVisibleCount(count: VisibleCount): string {
  switch (count.kind) {
    case 'known': return String(count.value);
    case 'unavailable': return 'Unavailable';
    case 'partial': return `${count.value}+ · partial`;
    case 'last_known': return `${count.value} · last known`;
    case 'checking': return count.value === null ? 'Checking' : `${count.value} · checking`;
  }
}
