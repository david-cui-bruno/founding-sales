import { describe, expect, it } from "vitest";
import { diffSnapshot } from "../src/snapshotDiff.js";

interface SentCommand {
  kind: "query" | "put";
  input: Record<string, unknown>;
}

/**
 * Minimal DI dynamo fake: answers Query with the configured prior item and
 * records every command it receives.
 */
function fakeDynamo(priorFingerprint: string | null) {
  const sent: SentCommand[] = [];
  return {
    sent,
    client: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async send(command: any): Promise<any> {
        const name = command.constructor.name;
        if (name === "QueryCommand") {
          sent.push({ kind: "query", input: command.input });
          return {
            Items:
              priorFingerprint === null
                ? []
                : [
                    {
                      source_natural_key: { S: "pvd-taxroll:29" },
                      snapshot_date: { S: "2026-08-25" },
                      content_fingerprint: { S: priorFingerprint },
                    },
                  ],
          };
        }
        if (name === "PutItemCommand") {
          sent.push({ kind: "put", input: command.input });
          return {};
        }
        throw new Error(`unexpected command ${name}`);
      },
    },
  };
}

const BASE = {
  table: "callie-sourcing-snapshots",
  naturalKey: "pvd-taxroll:29",
  contentFingerprint: "abc123",
  snapshotDate: "2026-09-01",
};

describe("diffSnapshot", () => {
  it("returns 'new' when no prior snapshot exists", async () => {
    const { client, sent } = fakeDynamo(null);
    const result = await diffSnapshot({ dynamo: client, ...BASE });
    expect(result).toBe("new");
    // Query then Put, always.
    expect(sent.map((c) => c.kind)).toEqual(["query", "put"]);
  });

  it("returns 'unchanged' when the latest fingerprint matches", async () => {
    const { client, sent } = fakeDynamo("abc123");
    const result = await diffSnapshot({ dynamo: client, ...BASE });
    expect(result).toBe("unchanged");
    // Still writes today's row.
    expect(sent.filter((c) => c.kind === "put")).toHaveLength(1);
  });

  it("returns 'changed' when the latest fingerprint differs", async () => {
    const { client } = fakeDynamo("something-else");
    const result = await diffSnapshot({ dynamo: client, ...BASE });
    expect(result).toBe("changed");
  });

  it("queries latest-first with Limit 1 on the natural key", async () => {
    const { client, sent } = fakeDynamo("abc123");
    await diffSnapshot({ dynamo: client, ...BASE });
    const query = sent.find((c) => c.kind === "query")!.input as {
      ScanIndexForward: boolean;
      Limit: number;
      TableName: string;
      ExpressionAttributeValues: Record<string, { S: string }>;
    };
    expect(query.ScanIndexForward).toBe(false);
    expect(query.Limit).toBe(1);
    expect(query.TableName).toBe(BASE.table);
    expect(query.ExpressionAttributeValues[":pk"]).toEqual({ S: BASE.naturalKey });
  });

  it("writes today's row with key + fingerprint", async () => {
    const { client, sent } = fakeDynamo(null);
    await diffSnapshot({ dynamo: client, ...BASE });
    const put = sent.find((c) => c.kind === "put")!.input as {
      TableName: string;
      Item: Record<string, { S: string }>;
    };
    expect(put.TableName).toBe(BASE.table);
    expect(put.Item.source_natural_key).toEqual({ S: BASE.naturalKey });
    expect(put.Item.snapshot_date).toEqual({ S: BASE.snapshotDate });
    expect(put.Item.content_fingerprint).toEqual({ S: BASE.contentFingerprint });
  });
});
