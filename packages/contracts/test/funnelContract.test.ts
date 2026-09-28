import { describe, expect, it } from 'vitest';
import { dashboardResponseSchema } from '../src/index.ts';

/**
 * `POST /dashboard`'s `funnel` key (lane J-facts, migration 0022).
 *
 * The three older sources are `z.object({ available: true }).loose()` because their
 * own fields are still moving. The funnel's are not: the read answers four figures
 * and is finished, so the schema names them. Naming them buys one thing the loose
 * shape could not — **a field a later lane adds to the server's DTO does not reach
 * the renderer until this schema names it too**, which is the client half of 14.1's
 * "responses are typed and redacted for the caller's visibility class".
 *
 * These cases are the difference between the two spellings, written down so a later
 * edit back to `.loose()` fails rather than quietly widening the wire.
 */

const body = (funnel: unknown): Record<string, unknown> => ({
  window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
  audience: 'workspace',
  firmsInScope: 4,
  messages: { incomingMatched: 0, human: 0, uncertain: 0, automated: 0, bounces: 0, optOuts: 0 },
  replyHandling: { replies: 0, handled: 0, medianSecondsToHandle: null, slowestSecondsToHandle: null },
  calls: [],
  stageMovement: [],
  holds: { open: 0, byReason: [] },
  suppressions: [],
  sending: { available: false, owner: 'G7-2', reason: 'not wired' },
  enrollments: { available: false, owner: 'G8', reason: 'not wired' },
  classifier: { available: false, owner: 'G7b', reason: 'not wired' },
  funnel,
});

describe('the funnel on the wire', () => {
  it('parses the four figures the read answers', () => {
    const parsed = dashboardResponseSchema.parse(
      body({
        available: true,
        byKind: [{ key: 'firm.created', count: 3 }],
        firmsByKind: [{ key: 'firm.created', count: 3 }],
        uniqueFirms: 3,
        firmsInScope: 4,
      }),
    );
    expect(parsed.funnel).toEqual({
      available: true,
      byKind: [{ key: 'firm.created', count: 3 }],
      firmsByKind: [{ key: 'firm.created', count: 3 }],
      uniqueFirms: 3,
      firmsInScope: 4,
    });
  });

  it('strips a field the schema does not name, which `.loose()` would have carried', () => {
    const parsed = dashboardResponseSchema.parse(
      body({
        available: true,
        byKind: [{ key: 'firm.created', count: 3 }],
        firmsByKind: [],
        uniqueFirms: 3,
        firmsInScope: 4,
        // A later lane's addition, with a nested object under it. Under `.loose()`
        // both would have reached the renderer unannounced.
        byOwner: [{ userId: '00000000-0000-4000-8000-000000000000', detail: { name: 'Dana Placeholder' } }],
      }),
    );
    expect(parsed.funnel).not.toHaveProperty('byOwner');
    expect(JSON.stringify(parsed)).not.toContain('Dana');
  });

  it('still takes the unavailable shape, because a figure nobody can compute says so', () => {
    const parsed = dashboardResponseSchema.parse(
      body({ available: false, owner: 'J-facts', reason: 'no funnel source was wired for this read' }),
    );
    expect(parsed.funnel).toMatchObject({ available: false, owner: 'J-facts' });
  });

  it('refuses a funnel that is neither shape', () => {
    expect(() => dashboardResponseSchema.parse(body({ available: true, byKind: 'all of them' }))).toThrow();
  });
});
