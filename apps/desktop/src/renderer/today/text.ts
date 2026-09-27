/** An empty value, shown as a dash rather than as nothing at all. */
export function orDash(value: string | null): string {
  return value === null || value.length === 0 ? '—' : value;
}
