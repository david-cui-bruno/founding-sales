import { randomUUID } from "node:crypto";
import type { CallToBookingFixture } from "./callToBookingCases.ts";
import type { SqlParameter } from "../../../db/queryable.ts";
type Fixture = CallToBookingFixture & { crm: { alpha: { firmId: string } } };
type Row = Record<string, SqlParameter>;
type Case = { constraint: string; run(f: Fixture): Promise<unknown> };
const absent = "00000000-0000-4000-8000-000000004890";
const hash = "a".repeat(64);
async function insert(f: Fixture, table: string, row: Row) {
  const keys = Object.keys(row);
  return await f.session.query(
    `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
    Object.values(row),
  );
}
function anchor(f: Fixture, patch: Row = {}) {
  return {
    workspace_id: f.seeded.alpha.workspaceId,
    id: randomUUID(),
    source_kind: "selected_note",
    source_id: randomUUID(),
    source_revision: 1,
    source_hash: hash,
    owner_user_id: f.seeded.alpha.salesperson.userId,
    original_access_closure: '{"firmIds":[],"personIds":[]}',
    context_snapshot: JSON.stringify({
      personId: null,
      firmIds: [],
      relationships: [],
      review: "current",
    }),
    context_hash: hash,
    semantic_hash: randomUUID().replaceAll("-", "").repeat(2),
    review_family_hash: hash,
    claim_kind: "need",
    locator_hash: hash,
    original_claim_id: randomUUID(),
    original_claim_hash: hash,
    original_claim_revision: 1,
    original_observed_at: "2026-10-01T00:00:00Z",
    ...patch,
  };
}
async function decision(f: Fixture, patch: Row = {}) {
  const a = anchor(f);
  await insert(f, "crm_claim_review_anchors", a);
  return {
    workspace_id: a.workspace_id,
    anchor_id: a.id,
    revision: 1,
    action: "confirm",
    actor_user_id: f.seeded.alpha.salesperson.userId,
    ...patch,
  };
}
function group(f: Fixture, patch: Row = {}) {
  return {
    workspace_id: f.seeded.alpha.workspaceId,
    id: randomUUID(),
    current_revision: 1,
    ...patch,
  };
}
async function conflictRevision(f: Fixture, patch: Row = {}) {
  const g = group(f);
  await insert(f, "crm_claim_conflicts", g);
  return {
    workspace_id: g.workspace_id,
    conflict_id: g.id,
    revision: 1,
    state: "open",
    actor_user_id: f.seeded.alpha.salesperson.userId,
    ...patch,
  };
}
async function member(f: Fixture, patch: Row = {}) {
  const r = await conflictRevision(f);
  await insert(f, "crm_claim_conflict_revisions", r);
  const a = anchor(f);
  await insert(f, "crm_claim_review_anchors", a);
  return {
    workspace_id: r.workspace_id,
    conflict_id: r.conflict_id,
    revision: 1,
    anchor_id: a.id,
    ...patch,
  };
}
async function work(f: Fixture, patch: Row = {}) {
  const a = anchor(f);
  await insert(f, "crm_claim_review_anchors", a);
  return {
    workspace_id: a.workspace_id,
    id: randomUUID(),
    work_kind: "call_task",
    work_id: randomUUID(),
    anchor_id: a.id,
    observed_work_version: "2026-10-01T00:00:00Z",
    observed_decision_revision: 0,
    ...patch,
  };
}
function columnCases(
  table: string,
  make: (f: Fixture, patch: Row) => Row | Promise<Row>,
  cases: readonly (readonly [string, Row])[],
): Case[] {
  return cases.map(([constraint, patch]) => ({
    constraint,
    run: async (f) => await insert(f, table, await make(f, patch)),
  }));
}
export const CRM_EVIDENCE_CONSTRAINT_CASES: readonly Case[] = [
  {
    constraint: "crm_selected_original_identity_immutable",
    run: async (f) => {
      const id = randomUUID();
      await insert(f, "crm_selected_sources", {
        workspace_id: f.seeded.alpha.workspaceId,
        id,
        firm_id: f.crm.alpha.firmId,
        owner_user_id: f.seeded.alpha.salesperson.userId,
        source_key_hash: hash,
        excerpt: "Selected test",
        content_hash: hash,
        occurred_at: "2026-10-01",
      });
      return f.session.query(
        "UPDATE crm_selected_sources SET owner_user_id=$3 WHERE workspace_id=$1 AND id=$2",
        [f.seeded.alpha.workspaceId, id, f.seeded.alpha.admin.userId],
      );
    },
  },

  ...columnCases("crm_claim_review_anchors", anchor, [
    [
      "crm_claim_anchor_original_access_closure",
      {
        original_access_closure:
          '{"firmIds":[],"personIds":[],"quote":"Private"}',
      },
    ],
    ["crm_claim_review_anchors_source_kind_check", { source_kind: "invented" }],
    ["crm_claim_review_anchors_source_revision_check", { source_revision: 0 }],
    ["crm_claim_review_anchors_source_hash_check", { source_hash: "invalid" }],
    [
      "crm_claim_review_anchors_context_snapshot_check",
      {
        context_snapshot:
          '{"personId":null,"firmIds":[],"relationships":[],"review":"current","quote":"Duplicated body"}',
      },
    ],
    [
      "crm_claim_review_anchors_context_hash_check",
      { context_hash: "invalid" },
    ],
    [
      "crm_claim_review_anchors_semantic_hash_check",
      { semantic_hash: "invalid" },
    ],
    [
      "crm_claim_review_anchors_review_family_hash_check",
      { review_family_hash: "invalid" },
    ],
    ["crm_claim_review_anchors_claim_kind_check", { claim_kind: "invented" }],
    [
      "crm_claim_review_anchors_locator_hash_check",
      { locator_hash: "invalid" },
    ],
    [
      "crm_claim_review_anchors_original_claim_hash_check",
      { original_claim_hash: "invalid" },
    ],
    [
      "crm_claim_review_anchors_original_claim_revision_check",
      { original_claim_revision: 2 },
    ],
    [
      "crm_claim_review_anchors_current_decision_revision_check",
      { current_decision_revision: -1 },
    ],
    [
      "crm_claim_review_anchors_availability_check",
      { availability: "invented" },
    ],
    ["crm_claim_review_anchors_check", { original_observed_at: null }],
    ["crm_claim_review_anchors_workspace_id_fkey", { workspace_id: absent }],
    [
      "crm_claim_review_anchors_workspace_id_owner_user_id_fkey",
      { owner_user_id: absent },
    ],
  ]),
  {
    constraint: "crm_claim_review_anchors_pkey",
    run: async (f) => {
      const row = anchor(f);
      await insert(f, "crm_claim_review_anchors", row);
      return insert(f, "crm_claim_review_anchors", row);
    },
  },
  {
    constraint: "crm_claim_review_anchors_workspace_id_semantic_hash_key",
    run: async (f) => {
      const row = anchor(f);
      await insert(f, "crm_claim_review_anchors", row);
      return insert(f, "crm_claim_review_anchors", {
        ...row,
        id: randomUUID(),
      });
    },
  },
  {
    constraint: "crm_claim_anchor_original_immutable",
    run: async (f) => {
      const row = anchor(f);
      await insert(f, "crm_claim_review_anchors", row);
      return f.session.query(
        "UPDATE crm_claim_review_anchors SET original_access_closure=$3::jsonb WHERE workspace_id=$1 AND id=$2",
        [
          row["workspace_id"],
          row["id"],
          JSON.stringify({ firmIds: [absent], personIds: [] }),
        ],
      );
    },
  },
  {
    constraint: "crm_selected_original_access_closure",
    run: async (f) => {
      await f.session.query(
        "ALTER TABLE crm_selected_sources DISABLE TRIGGER crm_selected_original_access_capture",
      );
      return insert(f, "crm_selected_sources", {
        workspace_id: f.seeded.alpha.workspaceId,
        id: randomUUID(),
        firm_id: f.crm.alpha.firmId,
        owner_user_id: f.seeded.alpha.salesperson.userId,
        source_key_hash: hash,
        excerpt: "Selected test",
        content_hash: hash,
        occurred_at: "2026-10-01",
        original_access_closure: '{"wrong":[],"other":[]}',
      });
    },
  },
  ...columnCases("crm_claim_decision_revisions", decision, [
    ["crm_claim_decision_revisions_revision_check", { revision: 0 }],
    ["crm_claim_decision_revisions_action_check", { action: "invented" }],
    [
      "crm_claim_decision_revisions_corrected_interpretation_check",
      { action: "correct", corrected_interpretation: "x".repeat(1001) },
    ],
    [
      "crm_claim_decision_revisions_rationale_check",
      { rationale: "x".repeat(1001) },
    ],
    ["crm_claim_decision_revisions_check", { action: "correct" }],
    [
      "crm_claim_decision_revisions_workspace_id_anchor_id_fkey",
      { anchor_id: absent },
    ],
    [
      "crm_claim_decision_revisions_workspace_id_actor_user_id_fkey",
      { actor_user_id: absent },
    ],
  ]),
  {
    constraint: "crm_claim_decision_revisions_pkey",
    run: async (f) => {
      const row = await decision(f);
      await insert(f, "crm_claim_decision_revisions", row);
      return insert(f, "crm_claim_decision_revisions", row);
    },
  },
  {
    constraint: "crm_claim_decision_append_only",
    run: async (f) => {
      const row = await decision(f);
      await insert(f, "crm_claim_decision_revisions", row);
      return f.session.query(
        "UPDATE crm_claim_decision_revisions SET action='dismiss' WHERE workspace_id=$1 AND anchor_id=$2",
        [row["workspace_id"], row["anchor_id"]],
      );
    },
  },
  ...columnCases("crm_claim_conflicts", group, [
    ["crm_claim_conflicts_current_revision_check", { current_revision: 0 }],
    ["crm_claim_conflicts_workspace_id_fkey", { workspace_id: absent }],
  ]),
  {
    constraint: "crm_claim_conflicts_pkey",
    run: async (f) => {
      const row = group(f);
      await insert(f, "crm_claim_conflicts", row);
      return insert(f, "crm_claim_conflicts", row);
    },
  },
  ...columnCases("crm_claim_conflict_revisions", conflictRevision, [
    ["crm_claim_conflict_revisions_revision_check", { revision: 0 }],
    [
      "crm_claim_conflict_revisions_state_check",
      { state: "invented", resolution: "keep_both" },
    ],
    [
      "crm_claim_conflict_revisions_resolution_check",
      { state: "resolved", resolution: "invented" },
    ],
    [
      "crm_claim_conflict_revisions_rationale_check",
      { rationale: "x".repeat(1001) },
    ],
    ["crm_claim_conflict_revisions_state_shape", { state: "resolved" }],
    [
      "crm_claim_conflict_revisions_redaction_shape",
      { redacted_at: "2026-10-01", rationale: "Private rationale" },
    ],
    [
      "crm_claim_conflict_revisions_workspace_id_conflict_id_fkey",
      { conflict_id: absent },
    ],
    [
      "crm_claim_conflict_revisions_workspace_id_actor_user_id_fkey",
      { actor_user_id: absent },
    ],
    [
      "crm_claim_conflict_revisions_workspace_id_preferred_anchor_fkey",
      {
        state: "resolved",
        resolution: "prefer_claim",
        preferred_anchor_id: absent,
      },
    ],
  ]),
  {
    constraint: "crm_claim_conflict_revisions_pkey",
    run: async (f) => {
      const row = await conflictRevision(f);
      await insert(f, "crm_claim_conflict_revisions", row);
      return insert(f, "crm_claim_conflict_revisions", row);
    },
  },
  {
    constraint: "crm_claim_conflict_revision_append_only",
    run: async (f) => {
      const row = await conflictRevision(f);
      await insert(f, "crm_claim_conflict_revisions", row);
      return f.session.query(
        "UPDATE crm_claim_conflict_revisions SET actor_user_id=$3 WHERE workspace_id=$1 AND conflict_id=$2",
        [row["workspace_id"], row["conflict_id"], f.seeded.alpha.admin.userId],
      );
    },
  },
  ...columnCases("crm_claim_conflict_members", member, [
    [
      "crm_claim_conflict_members_workspace_id_anchor_id_fkey",
      { anchor_id: absent },
    ],
    [
      "crm_claim_conflict_members_workspace_id_conflict_id_revisi_fkey",
      { revision: 2 },
    ],
  ]),
  {
    constraint: "crm_claim_conflict_members_pkey",
    run: async (f) => {
      const row = await member(f);
      await insert(f, "crm_claim_conflict_members", row);
      return insert(f, "crm_claim_conflict_members", row);
    },
  },
  {
    constraint: "crm_claim_conflict_member_append_only",
    run: async (f) => {
      const row = await member(f);
      await insert(f, "crm_claim_conflict_members", row);
      return f.session.query(
        "DELETE FROM crm_claim_conflict_members WHERE workspace_id=$1 AND conflict_id=$2",
        [row["workspace_id"], row["conflict_id"]],
      );
    },
  },
  ...(
    [
      "crm_claim_conflict_members_shape",
      "crm_claim_conflict_revision_members",
    ] as const
  ).map((constraint) => ({
    constraint,
    run: async (f: Fixture) => {
      const row = await member(f);
      await insert(f, "crm_claim_conflict_members", row);
      return await f.session.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`);
    },
  })),
  ...columnCases("crm_claim_work_dependencies", work, [
    ["crm_claim_work_dependencies_work_kind_check", { work_kind: "invented" }],
    [
      "crm_claim_work_dependencies_observed_work_version_check",
      { observed_work_version: "" },
    ],
    [
      "crm_claim_work_dependencies_observed_decision_revision_check",
      { observed_decision_revision: -1 },
    ],
    [
      "crm_claim_work_dependencies_review_reason_check",
      { review_required: true, review_reason: "invented" },
    ],
    [
      "crm_claim_work_dependencies_invalidation_revision_check",
      { invalidation_revision: 0 },
    ],
    ["crm_claim_work_dependencies_check", { review_required: true }],
    [
      "crm_claim_work_dependencies_workspace_id_anchor_id_fkey",
      { anchor_id: absent },
    ],
  ]),
  {
    constraint: "crm_claim_work_dependencies_pkey",
    run: async (f) => {
      const row = await work(f);
      await insert(f, "crm_claim_work_dependencies", row);
      return insert(f, "crm_claim_work_dependencies", row);
    },
  },
  {
    constraint:
      "crm_claim_work_dependencies_workspace_id_work_kind_work_id__key",
    run: async (f) => {
      const row = await work(f);
      await insert(f, "crm_claim_work_dependencies", row);
      return insert(f, "crm_claim_work_dependencies", {
        ...row,
        id: randomUUID(),
      });
    },
  },
];
