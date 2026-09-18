import { expect, it } from 'vitest';
import { PHASE_SLICES_MS, TICK_DEADLINE_MS } from '../src/sourceCoordinator';

// research, configurations, submitted commands, publications, territory backfill: every phase gets a slice and all five fit inside one scheduled tick.
it('phase slices fit inside one scheduled tick, with research given the largest slice', () => {
  expect(PHASE_SLICES_MS).toHaveLength(5);
  expect(PHASE_SLICES_MS.reduce((sum, slice) => sum + slice, 0)).toBeLessThanOrEqual(TICK_DEADLINE_MS);
  expect(TICK_DEADLINE_MS).toBe(45000);
  expect(PHASE_SLICES_MS[0]).toBe(18000);
  expect(Math.max(...PHASE_SLICES_MS)).toBe(PHASE_SLICES_MS[0]);
  expect(Math.min(...PHASE_SLICES_MS)).toBeGreaterThanOrEqual(6000);
});
