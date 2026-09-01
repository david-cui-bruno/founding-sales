/**
 * Hot-trigger push notifications via ntfy.
 *
 * Design rules:
 * - PII-free payload: locality/platform and typed facts only. NEVER a person
 *   name, phone, email, or free text from the source (CONTRACT.md).
 * - Fire-and-forget: a push failure must never fail mail processing. Errors
 *   are logged and swallowed by the caller.
 * - Topic is a long random string provisioned in SSM
 *   (/callie-sourcing/ntfy-topic) and injected as NTFY_TOPIC env.
 */
import type { CloudSourceEvent } from "@callie-sourcing/shared";

export const NTFY_BASE_URL = "https://ntfy.sh";

/** Channels that warrant an immediate phone push. */
const HOT_CHANNELS = new Set<CloudSourceEvent["channel"]>(["frbo", "community"]);

export function isHotEvent(event: CloudSourceEvent): boolean {
  return HOT_CHANNELS.has(event.channel) && event.trigger !== null;
}

/**
 * One-line, PII-free summary for a hot event.
 * Examples:
 *   "FRBO listing · Providence · $1,800 · 3bd"
 *   "Community post · reddit · pain: plumbing, unresponsive"
 */
export function buildHotPushMessage(event: CloudSourceEvent): string {
  if (event.channel === "frbo") {
    const payload = event.payload as {
      rent_usd: number | null;
      beds: number | null;
    };
    const locality = event.entity.property?.situs_address?.locality ?? "unknown area";
    const parts = [`FRBO listing · ${locality}`];
    if (payload.rent_usd !== null) parts.push(`$${payload.rent_usd.toLocaleString("en-US")}`);
    if (payload.beds !== null) parts.push(`${payload.beds}bd`);
    return parts.join(" · ");
  }
  const payload = event.payload as { platform: string };
  const pains = event.signal_flags.pain_mentions;
  const parts = [`Community post · ${payload.platform}`];
  if (pains.length > 0) parts.push(`pain: ${pains.join(", ")}`);
  return parts.join(" · ");
}

export interface NotifyDeps {
  fetchImpl: typeof fetch;
  topic: string;
}

/**
 * Publish one push per hot event (batched mails rarely exceed a handful).
 * Returns the number of pushes attempted successfully.
 */
export async function pushHotEvents(
  deps: NotifyDeps,
  events: readonly CloudSourceEvent[],
): Promise<number> {
  let sent = 0;
  for (const event of events) {
    if (!isHotEvent(event)) continue;
    const response = await deps.fetchImpl(`${NTFY_BASE_URL}/${deps.topic}`, {
      method: "POST",
      body: buildHotPushMessage(event),
      headers: {
        Title: "Callie hot lead",
        Priority: "high",
        Tags: "fire",
      },
    });
    if (response.ok) sent += 1;
  }
  return sent;
}
