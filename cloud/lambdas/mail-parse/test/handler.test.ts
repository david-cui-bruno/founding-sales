import { describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  loadSecureParameter,
  validateSourceEvent,
  type CloudSourceEvent,
} from "@callie-sourcing/shared";
import type { SESEvent } from "aws-lambda";
import { createHandler, handlerWithDeps, type HandlerDeps } from "../src/handler";
import {
  apartmentsAlertMime,
  f5botAlertMime,
  testMailMime,
  testOverrideF5botMime,
  unknownMailMime,
  zillowAlertMime,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Hand-rolled DI fakes (no network)
// ---------------------------------------------------------------------------

interface FakeState {
  rawMail: Map<string, Buffer>;
  inboxPuts: Array<{ key: string; body: string }>;
  dynamoKeys: Set<string>;
  dynamoPuts: Array<Record<string, unknown>>;
  failDynamoWith?: Error;
  missingObjectError?: Error;
}

function fakeDeps(state: FakeState): HandlerDeps {
  return {
    s3: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: (async (command: any) => {
        const name = command.constructor.name;
        if (name === "GetObjectCommand") {
          const key: string = command.input.Key;
          const buf = state.rawMail.get(key);
          if (!buf) throw state.missingObjectError ?? new Error(`NoSuchKey: ${key}`);
          return {
            Body: { transformToByteArray: async () => new Uint8Array(buf) },
          };
        }
        if (name === "PutObjectCommand") {
          state.inboxPuts.push({ key: command.input.Key, body: command.input.Body });
          return {};
        }
        throw new Error(`unexpected s3 command ${name}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    },
    dynamo: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: (async (command: any) => {
        if (state.failDynamoWith) throw state.failDynamoWith;
        const key: string = command.input.Item.idempotency_key.S;
        if (state.dynamoKeys.has(key)) {
          throw new ConditionalCheckFailedException({
            message: "The conditional request failed",
            $metadata: {},
          });
        }
        state.dynamoKeys.add(key);
        state.dynamoPuts.push(command.input.Item);
        return {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    },
    getNtfyTopic: async () => null,
    env: {
      RAW_MAIL_BUCKET: "raw-bucket",
      INBOX_BUCKET: "inbox-bucket",
      IDEMPOTENCY_TABLE: "idem-table",
    },
    now: () => new Date("2026-09-01T04:00:00.000Z"),
  };
}

function sesEvent(messageId: string): SESEvent {
  return {
    Records: [
      {
        eventSource: "aws:ses",
        eventVersion: "1.0",
        ses: {
          mail: { messageId } as never,
          receipt: { recipients: ["alerts@in.usecallie.com"] } as never,
        },
      },
    ],
  } as SESEvent;
}

function newState(messageId: string, mime: Buffer): FakeState {
  return {
    rawMail: new Map([[`raw-mail/${messageId}`, mime]]),
    inboxPuts: [],
    dynamoKeys: new Set(),
    dynamoPuts: [],
  };
}

function parseNdjson(body: string): CloudSourceEvent[] {
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CloudSourceEvent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handlerWithDeps", () => {
  it("zillow alert -> two valid frbo events in one ndjson file", async () => {
    const state = newState("msg-zillow", zillowAlertMime);
    await handlerWithDeps(sesEvent("msg-zillow"), fakeDeps(state));

    expect(state.inboxPuts).toHaveLength(1);
    const put = state.inboxPuts[0]!;
    expect(put.key).toMatch(
      /^events\/2026-09-01\/mail-parse-[0-9A-HJKMNP-TV-Z]{26}\.ndjson$/,
    );

    const events = parseNdjson(put.body);
    expect(events).toHaveLength(2);
    for (const event of events) {
      const result = validateSourceEvent(event);
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(event.channel).toBe("frbo");
      expect(event.trigger).toEqual({
        type: "frbo_listing",
        weight: 1,
        half_life_days: 3,
        window: null,
      });
      expect(event.entity.person).toBeNull();
      expect(event.scores).toBeNull();
      expect(event.provenance.confidence).toBe(0.9);
    }
    expect(events[0]!.entity.property?.situs_address?.line1).toBe("123 Hope St");
    expect(state.dynamoPuts).toHaveLength(2);
    // TTL is ~90 days out.
    const expiresAt = Number((state.dynamoPuts[0]!.expires_at as { N: string }).N);
    const nowSec = new Date("2026-09-01T04:00:00.000Z").getTime() / 1000;
    expect(expiresAt).toBe(nowSec + 90 * 24 * 60 * 60);
  });

  it("apartments alert -> one frbo event", async () => {
    const state = newState("msg-apts", apartmentsAlertMime);
    await handlerWithDeps(sesEvent("msg-apts"), fakeDeps(state));

    const events = parseNdjson(state.inboxPuts[0]!.body);
    expect(events).toHaveLength(1);
    expect(validateSourceEvent(events[0]).success).toBe(true);
    expect((events[0]!.payload as { listing_url: string }).listing_url).toContain(
      "apartments.com",
    );
  });

  it("f5bot alert -> community events with pain flags, no prose", async () => {
    const state = newState("msg-f5", f5botAlertMime);
    await handlerWithDeps(sesEvent("msg-f5"), fakeDeps(state));

    const events = parseNdjson(state.inboxPuts[0]!.body);
    expect(events).toHaveLength(2);

    const reddit = events[0]!;
    expect(validateSourceEvent(reddit).success).toBe(true);
    expect(reddit.channel).toBe("community");
    expect(reddit.payload).toEqual({
      platform: "reddit",
      topic_keywords: ["landlord software"],
      post_url:
        "https://www.reddit.com/r/Landlord/comments/abc123/what_software_do_you_all_use/",
    });
    expect(reddit.signal_flags.pain_mentions).toEqual(["unresponsive", "mold"]);
    expect(reddit.signal_flags.urgency).toBe(1);
    expect(reddit.trigger?.type).toBe("community_post");
    expect(reddit.trigger?.half_life_days).toBe(7);

    // Design rule: the post title must never appear anywhere in the event.
    expect(JSON.stringify(reddit)).not.toContain("What software");

    const hn = events[1]!;
    expect((hn.payload as { platform: string }).platform).toBe("hackernews");
  });

  it("test-only override header forces f5bot classification for test sender", async () => {
    const state = newState("msg-override", testOverrideF5botMime);
    await handlerWithDeps(sesEvent("msg-override"), fakeDeps(state));

    expect(state.inboxPuts).toHaveLength(1);
    const events = parseNdjson(state.inboxPuts[0]!.body);
    expect(events).toHaveLength(1);
    expect(events[0]!.channel).toBe("community");
    expect(events[0]!.signal_flags.pain_mentions).toEqual(
      expect.arrayContaining(["slow_repair", "no_heat"]),
    );
  });

  it("test mail writes no events and returns cleanly", async () => {
    const state = newState("msg-test", testMailMime);
    await handlerWithDeps(sesEvent("msg-test"), fakeDeps(state));
    expect(state.inboxPuts).toHaveLength(0);
    expect(state.dynamoPuts).toHaveLength(0);
  });

  it("unknown mail writes no events and returns cleanly", async () => {
    const state = newState("msg-unknown", unknownMailMime);
    await handlerWithDeps(sesEvent("msg-unknown"), fakeDeps(state));
    expect(state.inboxPuts).toHaveLength(0);
  });

  it("skips events whose idempotency key is already claimed", async () => {
    const state = newState("msg-f5-dup", f5botAlertMime);
    const deps = fakeDeps(state);

    await handlerWithDeps(sesEvent("msg-f5-dup"), deps);
    expect(parseNdjson(state.inboxPuts[0]!.body)).toHaveLength(2);

    // Same mail again: all keys claimed -> no second inbox write.
    await handlerWithDeps(sesEvent("msg-f5-dup"), deps);
    expect(state.inboxPuts).toHaveLength(1);
  });

  it("propagates non-conditional dynamo errors (fail closed)", async () => {
    const state = newState("msg-f5-err", f5botAlertMime);
    state.failDynamoWith = new Error("dynamo down");
    await expect(
      handlerWithDeps(sesEvent("msg-f5-err"), fakeDeps(state)),
    ).rejects.toThrow("dynamo down");
    expect(state.inboxPuts).toHaveLength(0);
  });

  it("throws on missing raw mail object", async () => {
    const state = newState("other-id", testMailMime);
    await expect(
      handlerWithDeps(sesEvent("missing-id"), fakeDeps(state)),
    ).rejects.toThrow("NoSuchKey");
  });

  it("handles empty Records without throwing", async () => {
    const state = newState("x", testMailMime);
    await handlerWithDeps({ Records: [] } as unknown as SESEvent, fakeDeps(state));
    expect(state.inboxPuts).toHaveLength(0);
  });
});

function assertSafeBoundaryFailure(failure: unknown, originalName: string, originalMessage: string): void {
  expect(failure).toBeInstanceOf(Error);
  const error = failure as Error;
  expect(error.name).toBe("SafeHandlerError");
  expect(error.message).toBe("Cloud handler invocation failed");
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(["message", "name", "stack"].sort());
  expect(error).not.toHaveProperty("cause");
  expect(error.name).not.toBe(originalName);
  expect(error.message).not.toContain(originalMessage);
  expect(JSON.stringify(error)).not.toContain(originalMessage);
}

describe("exported handler boundary", () => {
  it("continues ingestion when the optional ntfy parameter does not exist", async () => {
    const state = newState("msg-test", testOverrideF5botMime);
    const deps = fakeDeps(state);
    deps.getNtfyTopic = () =>
      loadSecureParameter({
        client: {
          send: async () => {
            throw Object.assign(new Error("private parameter identifier"), {
              name: "ParameterNotFound",
            });
          },
        },
        parameterName: "/callie-sourcing/ntfy-topic",
        required: false,
      });

    await expect(createHandler(() => deps)(sesEvent("msg-test"))).resolves.toBeUndefined();
  });
  it("writes the inbox and skips push when optional ntfy lookup is rejected", async () => {
    const state = newState("msg-test", testOverrideF5botMime);
    const deps = fakeDeps(state);
    const fetchImpl = vi.fn();
    deps.fetchImpl = fetchImpl as unknown as typeof fetch;
    deps.getNtfyTopic = async () => {
      throw Object.assign(new Error("ciphertext rejected for private parameter"), {
        name: "KMSInvalidStateException",
      });
    };

    await expect(createHandler(() => deps)(sesEvent("msg-test"))).resolves.toBeUndefined();

    expect(state.dynamoPuts).toHaveLength(1);
    expect(state.inboxPuts).toHaveLength(1);
    expect(parseNdjson(state.inboxPuts[0]!.body)).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("resolves the optional ntfy topic once per invocation without warm caching", async () => {
    const state = newState("msg-test", testOverrideF5botMime);
    const deps = fakeDeps(state);
    let lookups = 0;
    deps.getNtfyTopic = async () => {
      lookups += 1;
      return null;
    };
    const invocation = createHandler(() => deps);

    await invocation(sesEvent("msg-test"));
    state.dynamoKeys.clear();
    await invocation(sesEvent("msg-test"));

    expect(lookups).toBe(2);
  });
  it("replaces PII-bearing provider failures with the fixed safe error", async () => {
    const state = newState("other-message", Buffer.from(""));
    state.missingObjectError = Object.assign(
      new Error("private@example.test-secret-token provider body"),
      { name: "PrivateMailObjectError", privatePayload: "private@example.test-secret-token" },
    );
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const invocation = createHandler(() => fakeDeps(state));
    try {
      const failure = await invocation(sesEvent("private@example.test-secret-token")).then(() => undefined, (error) => error);
      assertSafeBoundaryFailure(failure, "PrivateMailObjectError", "private@example.test-secret-token");
      expect(failure).not.toHaveProperty("privatePayload");
    } finally {
      consoleSpy.mockRestore();
    }
    expect(output.join("\n")).not.toContain("private@example.test-secret-token");
  });
});
