import { randomUUID } from "node:crypto";
import type { SqlParameter } from "../../../db/queryable.ts";
import type { CallToBookingFixture } from "./callToBookingCases.ts";
type Fixture = CallToBookingFixture;
type Row = Record<string, SqlParameter>;
interface Case {
  constraint: string;
  run(f: Fixture): Promise<unknown>;
}
const missing = "00000000-0000-4000-8000-000000005570",
  hash = "a".repeat(64),
  closure = { firmIds: [], personIds: [] },
  context = {
    personId: null,
    firmIds: [],
    relationships: [],
    review: "current",
  };
const purpose = {
  purpose: "embedding",
  revision: 1,
  endpointId: "catalog-fake",
  modelVersion: "catalog-v1",
  accessGrantVersion: "grant-v1",
  dataHandlingVersion: "data-v1",
  evaluationFingerprint: hash,
  processorVersion: "processor-v1",
  retrievalVersion: "retrieval-v1",
  answerVersion: "answer-v1",
  supportVersion: "support-v1",
  chunkerVersion: "lexical-original-v1",
  inputTokenPriceMicros: 1,
  outputTokenPriceMicros: 0,
  dailyCeilingCents: 100,
  monthlyCeilingCents: 1000,
  embeddingDimensions: 256,
};
async function insert(f: Fixture, table: string, row: Row) {
  const columns = Object.keys(row);
  return f.session.query(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`,
    Object.values(row),
  );
}
function work(f: Fixture): Row {
  return {
    workspace_id: f.seeded.alpha.workspaceId,
    id: randomUUID(),
    owner_user_id: f.seeded.alpha.salesperson.userId,
    scope: JSON.stringify({ kind: "business" }),
    source_scope: JSON.stringify({ sources: [] }),
    context_snapshot: "[]",
    original_access_closure: JSON.stringify(closure),
    state: "pending",
    purpose_revision: 1,
    purpose_snapshot: JSON.stringify(purpose),
    config_fingerprint: hash,
    authorization_fingerprint: hash,
    next_ordinal: 1,
    total_windows: 0,
    revision: 1,
  };
}
async function window(f: Fixture): Promise<Row> {
  const parent = work(f);
  const sourceId = randomUUID();
  parent["source_scope"] = JSON.stringify({
    sources: [
      {
        workspaceId: f.seeded.alpha.workspaceId,
        sourceId,
        kind: "selected_note",
        revision: 1,
        contentHash: hash,
        locator: null,
      },
    ],
  });
  parent["context_snapshot"] = JSON.stringify([context]);
  await insert(f, "crm_ask_index_work", parent);
  return {
    workspace_id: f.seeded.alpha.workspaceId,
    id: randomUUID(),
    owner_user_id: f.seeded.alpha.salesperson.userId,
    work_id: parent["id"]!,
    source_kind: "selected_note",
    source_id: sourceId,
    source_revision: 1,
    source_hash: hash,
    locator: "text:0:4",
    text_hash: hash,
    context_hash: hash,
    context_snapshot: JSON.stringify(context),
    original_access_closure: JSON.stringify(closure),
    chunker_version: "lexical-original-v1",
    purpose_revision: 1,
    model_version: "catalog-v1",
    dimensions: 256,
    config_fingerprint: hash,
    embedding: null,
    state: "pending",
    ordinal: 1,
  };
}
async function receipt(f: Fixture): Promise<Row> {
  const source = await window(f);
  await insert(f, "crm_ask_canonical_windows", source);
  const reservationId = randomUUID(),
    jobId = randomUUID();
  await insert(f, "provider_reservations", {
    workspace_id: f.seeded.alpha.workspaceId,
    id: reservationId,
    provider_key: "catalog-fake",
    subject_kind: "crm_ask_embedding",
    subject_id: source["work_id"]!,
    attempt: 1,
    business_date: "2026-10-09",
    business_time_zone: "Etc/UTC",
    cents: 1,
    model_name: "catalog-v1",
    max_input_tokens: 1000,
    max_output_tokens: 100,
  });
  await insert(f, "jobs", {
    workspace_id: f.seeded.alpha.workspaceId,
    id: jobId,
    kind: "crm.ask_embedding",
    payload: "{}",
    idempotency_key: randomUUID(),
  });
  return {
    workspace_id: f.seeded.alpha.workspaceId,
    id: randomUUID(),
    work_id: source["work_id"]!,
    window_id: source["id"]!,
    attempt: 1,
    reservation_id: reservationId,
    job_id: jobId,
    fencing_token: 1,
    purpose_snapshot: JSON.stringify(purpose),
    purpose_revision: 1,
    config_fingerprint: hash,
    authorization_fingerprint: hash,
    input_hash: hash,
    input_price_micros: 1,
    output_price_micros: 0,
    max_input_tokens: 1000,
    dispatch_state: "reserved",
  };
}
const builders: Record<string, (f: Fixture) => Row | Promise<Row>> = {
  crm_ask_index_work: work,
  crm_ask_canonical_windows: window,
  crm_ask_index_receipts: receipt,
};
const cases: Case[] = [];
function bad(constraint: string, table: string, patch: Row): Case {
  return {
    constraint,
    run: async (f) =>
      insert(f, table, { ...(await builders[table]!(f)), ...patch }),
  };
}
for (const [table, fields] of Object.entries({
  crm_ask_index_work: {
    config_fingerprint: "bad",
    authorization_fingerprint: "bad",
    state: "bad",
    next_ordinal: 0,
    total_windows: 1001,
    revision: 0,
  },
  crm_ask_canonical_windows: {
    source_kind: "bad",
    source_revision: 0,
    source_hash: "bad",
    locator: "",
    text_hash: "bad",
    context_hash: "bad",
    purpose_revision: 0,
    dimensions: 257,
    config_fingerprint: "bad",
    state: "bad",
    ordinal: 0,
  },
  crm_ask_index_receipts: {
    attempt: 0,
    config_fingerprint: "bad",
    authorization_fingerprint: "bad",
    input_hash: "bad",
    input_price_micros: 0,
    output_price_micros: -1,
    max_input_tokens: 0,
    dispatch_state: "bad",
  },
}))
  for (const [column, value] of Object.entries(fields))
    cases.push(bad(`${table}_${column}_check`, table, { [column]: value }));
for (const [table, column, constraint] of [
  [
    "crm_ask_index_work",
    "owner_user_id",
    "crm_ask_index_work_workspace_id_owner_user_id_fkey",
  ],
  [
    "crm_ask_canonical_windows",
    "owner_user_id",
    "crm_ask_canonical_windows_workspace_id_owner_user_id_fkey",
  ],
  [
    "crm_ask_canonical_windows",
    "work_id",
    "crm_ask_canonical_windows_workspace_id_work_id_fkey",
  ],
  [
    "crm_ask_index_receipts",
    "work_id",
    "crm_ask_index_receipts_workspace_id_work_id_fkey",
  ],
  [
    "crm_ask_index_receipts",
    "reservation_id",
    "crm_ask_index_receipts_workspace_id_reservation_id_fkey",
  ],
  [
    "crm_ask_index_receipts",
    "job_id",
    "crm_ask_index_receipts_workspace_id_job_id_fkey",
  ],
] as const)
  cases.push(bad(constraint, table, { [column]: missing }));
for (const table of Object.keys(builders))
  cases.push({
    constraint: `${table}_pkey`,
    run: async (f) => {
      const row = await builders[table]!(f);
      await insert(f, table, row);
      return insert(f, table, row);
    },
  });
for (const [table, constraint] of [
  [
    "crm_ask_canonical_windows",
    "crm_ask_canonical_windows_workspace_id_work_id_ordinal_key",
  ],
  [
    "crm_ask_index_receipts",
    "crm_ask_index_receipts_workspace_id_window_id_attempt_key",
  ],
] as const)
  cases.push({
    constraint,
    run: async (f) => {
      const row = await builders[table]!(f);
      await insert(f, table, row);
      return insert(f, table, { ...row, id: randomUUID() });
    },
  });
for (const patch of [
  { scope: "[]" },
  { source_scope: "[]" },
  { context_snapshot: "{}" },
  { original_access_closure: "[]" },
  { scope: null },
  { source_scope: null },
  { context_snapshot: null },
  { state: "deleted" },
])
  cases.push(bad("crm_ask_index_work_shape", "crm_ask_index_work", patch));
cases.push(
  bad("crm_ask_index_purpose", "crm_ask_index_work", { purpose_revision: 0 }),
);
cases.push(
  bad("crm_ask_index_purpose", "crm_ask_index_work", {
    purpose_snapshot: JSON.stringify({ ...purpose, purpose: "answer" }),
  }),
);
cases.push(
  bad("crm_ask_index_receipt_purpose", "crm_ask_index_receipts", {
    purpose_snapshot: JSON.stringify({ ...purpose, revision: 2 }),
  }),
);
for (const embedding of [
  "{" + Array(256).fill(0).join(",") + "}",
  "{}",
  "{" + Array(255).fill(1).concat("NULL").join(",") + "}",
  "{" + Array(255).fill(1).concat("Infinity").join(",") + "}",
])
  cases.push(
    bad("crm_ask_index_vector", "crm_ask_canonical_windows", {
      embedding,
      state: "current",
    }),
  );
for (const patch of [
  { context_snapshot: "[]" },
  { original_access_closure: "[]" },
  { state: "current", embedding: null },
  { state: "stale", embedding: "{" + Array(256).fill(1).join(",") + "}" },
])
  cases.push(
    bad("crm_ask_index_window_shape", "crm_ask_canonical_windows", patch),
  );
for (const patch of [
  { source_id: randomUUID() },
  { source_revision: 2 },
  { source_hash: "b".repeat(64) },
  { context_snapshot: JSON.stringify({ ...context, review: "required" }) },
  {
    original_access_closure: JSON.stringify({
      firmIds: [missing],
      personIds: [],
    }),
  },
  { purpose_revision: 2 },
  { model_version: "different-model" },
  { chunker_version: "different-chunker" },
  { dimensions: 512 },
  { state: "current", embedding: "{" + Array(256).fill(1).join(",") + "}" },
])
  cases.push(
    bad("crm_ask_canonical_window_binding", "crm_ask_canonical_windows", patch),
  );
cases.push({
  constraint: "crm_ask_canonical_window_binding",
  run: async (f) => {
    const row = await window(f);
    return insert(f, "crm_ask_canonical_windows", {
      ...row,
      owner_user_id: f.seeded.alpha.admin.userId,
    });
  },
});
export const ASK_CANONICAL_INDEX_CONSTRAINT_CASES: readonly Case[] = cases;

export async function seedCurrentCanonicalWindow(f: Fixture) {
  const row = await window(f);
  const value = {
    ...row,
    state: "current",
    embedding: "{" + Array(256).fill(1).join(",") + "}",
  };
  await insert(f, "crm_ask_canonical_windows", row);
  await f.session.query(
    "UPDATE crm_ask_canonical_windows SET state='current',embedding=$3::double precision[] WHERE workspace_id=$1 AND id=$2",
    [row["workspace_id"]!, row["id"]!, value.embedding],
  );
  return {
    workspaceId: String(row["workspace_id"]),
    windowId: String(row["id"]),
  };
}
