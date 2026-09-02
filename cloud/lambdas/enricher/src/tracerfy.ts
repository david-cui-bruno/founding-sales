/**
 * Tracerfy Instant Trace Lookup client (synchronous endpoint).
 *
 * POST {TRACERFY_BASE_URL}/v1/api/trace/lookup/ with find_owner: true.
 * 5 credits per hit, 0 on miss. The response is parsed leniently
 * (.passthrough(): the vendor documents `meta` as additive) but the fields we
 * consume are typed.
 *
 * Error mapping (per vendor docs + plan):
 *   402 -> no_credits   (founder problem: STOP the whole run)
 *   403 -> suspended    (founder problem: STOP the whole run)
 *   429 -> rate_limited (caller backs off 60s once, then stops)
 *   5xx -> server_error (caller retries once, then fails the run)
 * Anything else unexpected (400/401/404...) -> unexpected (fails the run:
 * a malformed request or bad key is a bug/config problem, not data).
 */
import { z } from "zod";

const tracerfyPhoneSchema = z
  .object({
    number: z.string(),
    type: z.string().nullish(),
    dnc: z.boolean().nullish(),
    tcpa: z.boolean().nullish(),
    carrier: z.string().nullish(),
    rank: z.number().int().nullish(),
  })
  .passthrough();
export type TracerfyPhone = z.infer<typeof tracerfyPhoneSchema>;

const tracerfyEmailSchema = z
  .object({
    email: z.string(),
    rank: z.number().int().nullish(),
  })
  .passthrough();
export type TracerfyEmail = z.infer<typeof tracerfyEmailSchema>;

const tracerfyMailingAddressSchema = z
  .object({
    street: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    zip: z.string().nullish(),
  })
  .passthrough();

const tracerfyPersonSchema = z
  .object({
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    full_name: z.string().nullish(),
    deceased: z.boolean().nullish(),
    property_owner: z.boolean().nullish(),
    litigator: z.boolean().nullish(),
    mailing_address: tracerfyMailingAddressSchema.nullish(),
    phones: z.array(tracerfyPhoneSchema).default([]),
    emails: z.array(tracerfyEmailSchema).default([]),
  })
  .passthrough();
export type TracerfyPerson = z.infer<typeof tracerfyPersonSchema>;

export const tracerfyLookupResponseSchema = z
  .object({
    hit: z.boolean(),
    persons_count: z.number().int().nullish(),
    credits_deducted: z.number().int().min(0).default(0),
    persons: z.array(tracerfyPersonSchema).default([]),
  })
  .passthrough();
export type TracerfyLookupResponse = z.infer<typeof tracerfyLookupResponseSchema>;

export interface TracerfyLookupInput {
  address: string;
  city: string;
  state: string;
  zip: string | null;
}

export type TracerfyLookupResult =
  | { kind: "ok"; response: TracerfyLookupResponse }
  | { kind: "no_credits" }
  | { kind: "suspended" }
  | { kind: "rate_limited" }
  | { kind: "server_error"; status: number }
  | { kind: "unexpected"; status: number; detail: string };

export async function instantTraceLookup(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  input: TracerfyLookupInput,
): Promise<TracerfyLookupResult> {
  const body: Record<string, unknown> = {
    address: input.address,
    city: input.city,
    state: input.state,
    find_owner: true,
  };
  // zip is optional but strongly recommended by the vendor; omit when absent.
  if (input.zip) body.zip = input.zip;

  const response = await fetchImpl(`${baseUrl}/v1/api/trace/lookup/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 402) return { kind: "no_credits" };
  if (response.status === 403) return { kind: "suspended" };
  if (response.status === 429) return { kind: "rate_limited" };
  if (response.status >= 500) return { kind: "server_error", status: response.status };
  if (!response.ok) {
    // 400/401/404/...: config or code bug, not a data condition.
    const detail = await response.text().catch(() => "");
    return { kind: "unexpected", status: response.status, detail: detail.slice(0, 500) };
  }

  const parsed = tracerfyLookupResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { kind: "unexpected", status: response.status, detail: parsed.error.message.slice(0, 500) };
  }
  return { kind: "ok", response: parsed.data };
}
