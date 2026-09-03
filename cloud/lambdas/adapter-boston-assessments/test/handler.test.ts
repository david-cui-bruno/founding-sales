import { describe, expect, it } from "vitest";
import { normalizeOwnerName } from "@callie-sourcing/shared";
import {
  buildOwnerSql,
  handlerWithDeps,
  ownerNameCandidates,
  type HandlerDeps,
  type SweptEntity,
} from "../src/handler";
import type { AssessmentRow } from "../src/assessments";
import {
  ROW_LLC_APARTMENT,
  ROW_R3_OWNER_OCC,
  ROW_TRUST_ABSENTEE,
} from "./fixtures";

const ENV = {
  INBOX_BUCKET: "inbox",
  IDEMPOTENCY_TABLE: "idem",
  SNAPSHOTS_TABLE: "snaps",
  ENTITIES_TABLE: "entities",
  MAX_RUNTIME_MS: 840000,
};

function entityFor(rawName: string): SweptEntity {
  return { canonicalName: rawName, normalizedName: normalizeOwnerName(rawName) };
}

interface FakeState {
  snapshots: Map<string, string>;
  claimedIdempotencyKeys: Set<string>;
  s3Writes: Array<{ Key: string; Body: string }>;
  sqlQueries: string[];
}

function fakeDeps(
  entities: SweptEntity[],
  rollRows: AssessmentRow[],
  state?: Partial<FakeState>,
): { deps: HandlerDeps; state: FakeState } {
  const full: FakeState = {
    snapshots: new Map(),
    claimedIdempotencyKeys: new Set(),
    s3Writes: [],
    sqlQueries: [],
    ...state,
  };

  const dynamo = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      const name = command.constructor.name;
      const input = command.input;
      if (name === "ScanCommand") {
        return {
          Items: entities.map((e) => ({
            canonical_name: { S: e.canonicalName },
            normalized_name: { S: e.normalizedName },
          })),
        };
      }
      if (name === "QueryCommand") {
        const key = input.ExpressionAttributeValues[":pk"].S as string;
        const fingerprint = full.snapshots.get(key);
        return {
          Items: fingerprint ? [{ content_fingerprint: { S: fingerprint } }] : [],
        };
      }
      if (name === "PutItemCommand") {
        if (input.TableName === ENV.SNAPSHOTS_TABLE) {
          full.snapshots.set(
            input.Item.source_natural_key.S as string,
            input.Item.content_fingerprint.S as string,
          );
          return {};
        }
        const key = input.Item.idempotency_key.S as string;
        if (full.claimedIdempotencyKeys.has(key)) {
          const error = new Error("conditional failed");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
        full.claimedIdempotencyKeys.add(key);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };

  const s3 = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      full.s3Writes.push(command.input);
      return {};
    },
  };

  const fetchImpl = (async (url: string | URL) => {
    const sql = new URL(String(url)).searchParams.get("sql") ?? "";
    full.sqlQueries.push(sql);
    const inMatch = sql.match(/IN \(([^)]*)\)/);
    const names = (inMatch?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, "").replace(/''/g, "'"));
    const records = rollRows.filter((row) =>
      names.includes((row.OWNER ?? "").toUpperCase().replace(/\s+/g, " ").trim()),
    );
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { records } }),
    } as unknown as Response;
  }) as typeof fetch;

  return {
    deps: {
      s3,
      dynamo,
      fetchImpl,
      env: { ...ENV },
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    },
    state: full,
  };
}

const ROLL = [ROW_R3_OWNER_OCC, ROW_TRUST_ABSENTEE, ROW_LLC_APARTMENT];

describe("ownerNameCandidates / buildOwnerSql", () => {
  it("includes canonical uppercase and distinct normalized form", () => {
    const candidates = ownerNameCandidates(entityFor("Maverick Holdings LLC"));
    expect(candidates).toContain("MAVERICK HOLDINGS LLC");
    expect(candidates).toContain("HOLDINGS MAVERICK");
  });

  it("skips ambiguous single-token normalized names", () => {
    const candidates = ownerNameCandidates({
      canonicalName: "SMITH",
      normalizedName: "SMITH",
    });
    expect(candidates).toEqual(["SMITH"]);
  });

  it("escapes single quotes in SQL literals", () => {
    const sql = buildOwnerSql(["O'BRIEN JOHN"]);
    expect(sql).toContain("'O''BRIEN JOHN'");
    expect(sql).toContain("LIMIT 50");
    expect(sql).toContain('UPPER("OWNER") IN');
  });
});

describe("handlerWithDeps", () => {
  it("sweeps entities and emits only matching owners' parcels", async () => {
    const entities = [
      entityFor("PASCUCCI CARLO"),
      entityFor("MAVERICK HOLDINGS LLC"),
      entityFor("NOBODY HERE"),
    ];
    const { deps, state } = fakeDeps(entities, ROLL);
    const result = await handlerWithDeps(null, deps);

    expect(result.entitiesScanned).toBe(3);
    expect(result.entitiesSwept).toBe(3);
    expect(result.entitiesMatched).toBe(2);
    expect(result.parcelsMatched).toBe(2);
    expect(result.new).toBe(2);
    expect(result.written).toBe(2);
    expect(result.completed).toBe(true);
    expect(state.s3Writes).toHaveLength(1);
    expect(state.s3Writes[0]!.Key).toMatch(
      /^events\/2026-09-03\/boston-assessments-.+\.ndjson$/,
    );
    const lines = state.s3Writes[0]!.Body.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const owners = lines.map((l) => JSON.parse(l).entity.person.full_name).sort();
    expect(owners).toEqual(["MAVERICK HOLDINGS LLC", "PASCUCCI CARLO"]);
  });

  it("re-run with same data emits nothing (snapshot unchanged)", async () => {
    const entities = [entityFor("PASCUCCI CARLO")];
    const first = fakeDeps(entities, ROLL);
    await handlerWithDeps(null, first.deps);

    const second = fakeDeps(entities, ROLL, { snapshots: first.state.snapshots });
    const result = await handlerWithDeps(null, second.deps);
    expect(result.unchanged).toBe(1);
    expect(result.written).toBe(0);
    expect(second.state.s3Writes).toHaveLength(0);
  });

  it("re-emits only changed rows", async () => {
    const entities = [entityFor("PASCUCCI CARLO"), entityFor("MAVERICK HOLDINGS LLC")];
    const first = fakeDeps(entities, ROLL);
    await handlerWithDeps(null, first.deps);

    const changedRoll = ROLL.map((row) =>
      row.PID === ROW_R3_OWNER_OCC.PID ? { ...row, TOTAL_VALUE: "999,999" } : row,
    );
    const second = fakeDeps(entities, changedRoll, {
      snapshots: first.state.snapshots,
    });
    const result = await handlerWithDeps(null, second.deps);
    expect(result.changed).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.written).toBe(1);
  });

  it("honors maxEntities", async () => {
    const entities = [entityFor("PASCUCCI CARLO"), entityFor("MAVERICK HOLDINGS LLC")];
    const { deps, state } = fakeDeps(entities, ROLL);
    const result = await handlerWithDeps({ maxEntities: 1 }, deps);
    expect(result.entitiesSwept).toBe(1);
    expect(result.written).toBe(1);
    expect(state.sqlQueries).toHaveLength(1);
  });

  it("dedupes a parcel matched by two entities", async () => {
    // Same person resolved under two entity rows (raw vs reordered name).
    const entities = [entityFor("PASCUCCI CARLO"), entityFor("CARLO PASCUCCI")];
    const { deps } = fakeDeps(entities, ROLL);
    const result = await handlerWithDeps(null, deps);
    expect(result.parcelsMatched).toBe(1);
    expect(result.written).toBe(1);
  });

  it("skips already-claimed idempotency keys", async () => {
    const entities = [entityFor("PASCUCCI CARLO")];
    const first = fakeDeps(entities, ROLL);
    await handlerWithDeps(null, first.deps);

    const second = fakeDeps(entities, ROLL, {
      claimedIdempotencyKeys: first.state.claimedIdempotencyKeys,
    });
    const result = await handlerWithDeps(null, second.deps);
    expect(result.new).toBe(1);
    expect(result.idempotencySkips).toBe(1);
    expect(result.written).toBe(0);
  });

  it("throws on CKAN HTTP and API errors", async () => {
    const { deps } = fakeDeps([entityFor("PASCUCCI CARLO")], ROLL);
    deps.fetchImpl = (async () =>
      ({ ok: false, status: 503 }) as unknown as Response) as typeof fetch;
    await expect(handlerWithDeps(null, deps)).rejects.toThrow(/HTTP 503/);

    deps.fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ success: false, error: { message: "bad sql" } }),
      }) as unknown as Response) as typeof fetch;
    await expect(handlerWithDeps(null, deps)).rejects.toThrow(
      /datastore_search_sql error/,
    );
  });
});
