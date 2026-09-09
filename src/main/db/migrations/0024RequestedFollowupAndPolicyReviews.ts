import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';

const text = (column: string, max = 200) => `typeof(${column}) = 'text'
 AND length(${column}) BETWEEN 1 AND ${max} AND trim(${column}) = ${column}
 AND instr(${column}, char(0)) = 0
 AND ${column} NOT GLOB '*[' || char(1) || '-' || char(31) || char(127) || ']*'`;
const uuid = (column: string) => `length(${column}) = 36
 AND substr(${column},9,1) = '-' AND substr(${column},14,1) = '-'
 AND substr(${column},19,1) = '-' AND substr(${column},24,1) = '-'
 AND length(replace(${column},'-','')) = 32
 AND replace(${column},'-','') NOT GLOB '*[^0-9a-f]*'
 AND (${column} IN ('00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff')
 OR (substr(${column},15,1) GLOB '[1-8]' AND substr(${column},20,1) GLOB '[89ab]'))`;
const utc = (column: string) => `typeof(${column})='text' AND length(${column})=24
 AND strftime('%Y-%m-%dT%H:%M:%fZ',${column},'+0 seconds') IS ${column}`;
const hash = (column: string) => `typeof(${column})='text' AND length(${column})=64 AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const object = (column: string) => `typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 2 AND 4194304 AND json_valid(${column}) AND json_type(${column})='object'`;

/** Additive storage only. No historical schema or execution authority is changed. */
export const migration0024RequestedFollowupAndPolicyReviews = {
  async up(db: Kysely<FoundationDatabase>) {
    const statements = [
      `CREATE TABLE delegated_requested_followup_drafts (
        workspace_id TEXT NOT NULL CHECK(${text('workspace_id')}),
        account_id TEXT NOT NULL REFERENCES pm_accounts(id) CHECK(${text('account_id')}),
        id TEXT NOT NULL CHECK(${text('id')}),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
        context_revision TEXT NOT NULL CHECK(${hash('context_revision')}),
        draft_json TEXT NOT NULL CHECK(${object('draft_json')}),
        approval_json TEXT CHECK(approval_json IS NULL OR (${object('approval_json')})),
        updated_at TEXT NOT NULL CHECK(${utc('updated_at')}),
        PRIMARY KEY(workspace_id,account_id,id))`,
      `CREATE TABLE account_route_policy_import_reviews (
        id TEXT PRIMARY KEY NOT NULL CHECK(${text('id', 36)} AND ${uuid('id')}),
        workspace_id TEXT NOT NULL CHECK(${text('workspace_id', 36)} AND ${uuid('workspace_id')}),
        artifact_sha256 TEXT NOT NULL CHECK(${hash('artifact_sha256')}),
        artifact_bytes BLOB NOT NULL CHECK(typeof(artifact_bytes)='blob' AND length(artifact_bytes) BETWEEN 1 AND 1048576),
        row_plans_json TEXT NOT NULL CHECK(typeof(row_plans_json)='text' AND json_valid(row_plans_json) AND json_type(row_plans_json)='array' AND length(CAST(row_plans_json AS BLOB))<=4194304),
        row_count INTEGER NOT NULL CHECK(typeof(row_count)='integer' AND row_count BETWEEN 1 AND 100 AND json_array_length(row_plans_json)=row_count),
        review_reason TEXT NOT NULL CHECK(${text('review_reason', 2000)}),
        reviewed_at TEXT NOT NULL CHECK(${utc('reviewed_at')}),
        reviewer_kind TEXT NOT NULL CHECK(reviewer_kind='local_owner_review'),
        review_policy_version TEXT NOT NULL CHECK(review_policy_version='account_route_policy_import_review_v1'),
        UNIQUE(workspace_id,artifact_sha256))`,
      ...['UPDATE', 'DELETE'].map(operation => `CREATE TRIGGER account_route_policy_import_reviews_no_${operation.toLowerCase()}
        BEFORE ${operation} ON account_route_policy_import_reviews BEGIN SELECT RAISE(ABORT,'Import review is immutable'); END`),
    ];
    for (const statement of statements) await sql.raw(statement).execute(db);
    await sql`UPDATE app_meta SET schema_version=24,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};
