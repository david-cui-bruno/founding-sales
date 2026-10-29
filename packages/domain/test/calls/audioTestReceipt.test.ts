import { expect, it, vi } from 'vitest';
import { readAudioTestExecutionReceipt } from '../../calls/audioTestReceipt.ts';
import { CallingAuthorityChanged } from '../../calling/followUpDraftAccess.ts';
import { audioTestWorld, destination, ids } from './audioTestWorld.ts';

const input = { commandId: ids.command, payloadSHA256: 'a'.repeat(64) };

it('recovers only the exact actor/device/kind/hash and never returns a destination or reconnect permission', async () => {
  const world = audioTestWorld(), authority = vi.fn(async () => true);
  const answer = await readAudioTestExecutionReceipt(world.context, input, ids.device, authority);
  expect(answer).toEqual({ state: 'accepted', sessionId: ids.session, expiresAt: world.state.expires, status: 'authorized', canReconnect: false });
  const receipt = world.trace.find(t => t.sql.includes('FROM command_receipts'))!;
  expect(receipt.values).toEqual([ids.workspace, ids.command, ids.device, ids.user, input.payloadSHA256]);
  expect(receipt.sql).toContain("r.command_kind='create_audio_test_session'");
  const binding = world.trace.find(t => t.sql.includes('JOIN browser_audio_test_requests'))!;
  expect(binding.sql).toContain("s.purpose='audio_test'"); expect(binding.sql).toContain('r.actor_user_id=$3 AND r.device_id=$4 AND r.command_id=$5');
  expect(binding.sql).toContain('FOR UPDATE OF s');
  expect(authority).toHaveBeenCalledTimes(1); expect(JSON.stringify(answer)).not.toContain(destination);
  expect(world.trace.some(t => /^(INSERT|UPDATE|DELETE)/u.test(t.sql))).toBe(false);
});
it('marks only an unconsumed expired test as expired and reads database time after the session lock', async () => {
  const world = audioTestWorld();
  world.hooks.beforeQuery = sql => { if (sql.includes('FOR UPDATE OF s')) world.state.now = world.state.expires; };
  expect(await readAudioTestExecutionReceipt(world.context, input, ids.device, async () => true)).toMatchObject({ state: 'accepted', status: 'expired_unconsumed', canReconnect: false });
  const session = world.trace.findIndex(t => t.sql.includes('FOR UPDATE OF s'));
  expect(world.trace.findIndex(t => t.sql === 'SELECT clock_timestamp() AS at')).toBeGreaterThan(session);
});
it.each(['authorized', 'ringing', 'in_progress', 'completed', 'failed', 'canceled'])('retains consumed %s after expiry and destination erasure', async status => {
  const world = audioTestWorld(); world.state.consumed = true; world.state.consumedAt = new Date(world.state.now);
  world.state.status = status; world.state.now = '2026-10-28T16:02:00.000Z'; world.state.e164 = null; world.state.erasedAt = new Date(world.state.now);
  expect(await readAudioTestExecutionReceipt(world.context, input, ids.device, async () => true)).toMatchObject({ state: 'accepted', status, canReconnect: false });
});
it('returns opaque refused and unknown responses without looking up a call destination', async () => {
  const world = audioTestWorld(); world.state.receiptStatus = 'refused';
  expect(await readAudioTestExecutionReceipt(world.context, input, ids.device, async () => true)).toEqual({ state: 'refused' });
  expect(world.trace.some(t => t.sql.includes('FROM call_sessions'))).toBe(false);
  expect(await readAudioTestExecutionReceipt(world.context, { ...input, payloadSHA256: 'b'.repeat(64) }, ids.device, async () => true)).toEqual({ state: 'unknown' });
});
it('rechecks device and current principal after receipt/session waits', async () => {
  const world = audioTestWorld();
  world.hooks.beforeQuery = sql => { if (sql.includes('FOR UPDATE OF s')) world.state.deviceActive = false; };
  expect(await readAudioTestExecutionReceipt(world.context, input, ids.device, async () => true)).toEqual({ state: 'unknown' });
  world.state.deviceActive = true;
  await expect(readAudioTestExecutionReceipt(world.context, input, ids.device, async () => false)).rejects.toBeInstanceOf(CallingAuthorityChanged);
  const final = world.trace.at(-1)!; expect(final.sql).toContain('workspace_memberships');
});
