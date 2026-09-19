import { lastTickLineSchema, type LastTickLine } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';
import { SOURCE_LAST_TICK_KEY } from '../tickLog';

/** The last scheduled tick, as Diagnostics and Today show it. Only the three fields the views need are read off the persisted record. */
export async function readLastTick(store: DynamoStore): Promise<LastTickLine | null> {
  const row = await store.get<unknown>(SOURCE_LAST_TICK_KEY);
  const parsed = lastTickLineSchema.safeParse(pick(row?.data));
  return parsed.success ? parsed.data : null;
}

function pick(data: unknown): unknown {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  return { at: record.at, status: record.status, durationMs: record.durationMs };
}
