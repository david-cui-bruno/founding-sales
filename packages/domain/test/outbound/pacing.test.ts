import { afterAll, beforeAll, expect, it } from 'vitest';
import { claimForDispatch, readFence } from '../../outbound/fence.ts';
import { prospectingRetryAt, prospectingSpacingMilliseconds } from '../../outbound/pacing.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { prepareFor, seedFirm } from './support/dispatchFixtures.ts';
let world: OutboundWorld;
beforeAll(async () => { world = await createOutboundWorld(); });
afterAll(async () => { await world?.stop(); });

it('spaces the starting allowance across an hour and retains a minimum at higher caps', () => {
  expect(prospectingSpacingMilliseconds(5)).toBe(12 * 60_000);
  expect(prospectingSpacingMilliseconds(10)).toBe(6 * 60_000);
  expect(prospectingSpacingMilliseconds(100)).toBe(60_000);
});

it('uses committed attempts including ambiguous ones, isolates mailboxes, and permits the exact retry instant', async () => {
  const ctx = world.systemContext(world.alpha.workspace.workspaceId);
  const mailboxId = world.alpha.mailboxId;
  expect(await prospectingRetryAt(ctx, { mailboxId, cap: 5, now: new Date().toISOString() })).toBeNull();
  const firm = await seedFirm(world, world.alpha, 'paced-claim');
  const id = await prepareFor(world, world.alpha, firm);
  expect((await claimForDispatch(ctx, { outboundMessageId: id })).ok).toBe(true);
  const fence = await readFence(ctx, id);
  const claimedAt = fence?.dispatchStartedAt;
  if (claimedAt === null || claimedAt === undefined) throw new Error('claim timestamp missing');
  const retryAt = new Date(Date.parse(claimedAt) + 12 * 60_000).toISOString();
  expect(await prospectingRetryAt(ctx, { mailboxId, cap: 5, now: claimedAt })).toBe(retryAt);
  expect(await prospectingRetryAt(ctx, { mailboxId, cap: 5, now: retryAt })).toBeNull();
  expect(await prospectingRetryAt(world.systemContext(world.beta.workspace.workspaceId), {
    mailboxId: world.beta.mailboxId, cap: 5, now: claimedAt,
  })).toBeNull();
});
