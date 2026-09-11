import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';

const integer = (name: string, minimum = 0) => `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name} BETWEEN ${minimum} AND 9007199254740991)`;
const hash = (name: string) => `${name} TEXT NOT NULL CHECK(length(${name})=64)`;
/** Additive23 only. Historical schema21/22 and their migration SQL remain unchanged. */
export const migration0023Campaigns = {
  async up(db: Kysely<FoundationDatabase>) {
    const statements = [
      `CREATE TABLE campaign_versions (workspace_id TEXT NOT NULL,id TEXT NOT NULL,campaign_id TEXT NOT NULL,${integer('version', 1)},
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),${hash('snapshot_hash')},created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,campaign_id,version))`,
      `CREATE TABLE campaign_approvals (workspace_id TEXT NOT NULL,campaign_version_id TEXT NOT NULL,${hash('snapshot_hash')},approved_at TEXT NOT NULL,command_id TEXT NOT NULL,
        PRIMARY KEY(workspace_id,campaign_version_id),UNIQUE(workspace_id,command_id),FOREIGN KEY(workspace_id,campaign_version_id) REFERENCES campaign_versions(workspace_id,id))`,
      `CREATE TABLE campaign_enrollments (workspace_id TEXT NOT NULL,id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES pm_accounts(id),campaign_version_id TEXT NOT NULL,
        selected_route_id TEXT NOT NULL,${integer('selected_route_version', 1)},person_id TEXT REFERENCES persons(id),current_step_id TEXT,${integer('version', 1)},
        state TEXT NOT NULL CHECK(state IN('active','held','paused','conversation','completed','stopped')),${integer('context_revision')},execution_context_id TEXT NOT NULL,
        started_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,account_id,id),
        FOREIGN KEY(workspace_id,campaign_version_id) REFERENCES campaign_versions(workspace_id,id),
        FOREIGN KEY(account_id,selected_route_id,selected_route_version) REFERENCES pm_account_routes(account_id,id,version))`,
      `CREATE UNIQUE INDEX campaign_one_nonterminal_account ON campaign_enrollments(workspace_id,account_id) WHERE state IN('active','held','paused','conversation')`,
      `CREATE TABLE campaign_step_receipts (workspace_id TEXT NOT NULL,id TEXT NOT NULL,account_id TEXT NOT NULL,enrollment_id TEXT NOT NULL,step_id TEXT NOT NULL,
        route_id TEXT NOT NULL,${integer('route_version', 1)},${integer('context_revision')},execution_context_id TEXT NOT NULL,action_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN('call','email','linkedin')),state TEXT NOT NULL CHECK(state IN('prepared','queued','dispatching','unknown','human_reported_sent','provider_accepted','cancelled')),
        outcome TEXT NOT NULL,observation TEXT NOT NULL CHECK(observation IN('unknown','no_reply','replied')),source TEXT NOT NULL CHECK(source IN('provider','human')),
        observed_at TEXT NOT NULL,command_id TEXT NOT NULL,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,command_id),
        FOREIGN KEY(workspace_id,account_id,enrollment_id) REFERENCES campaign_enrollments(workspace_id,account_id,id),
        FOREIGN KEY(account_id,route_id,route_version) REFERENCES pm_account_routes(account_id,id,version))`,
      `CREATE TABLE campaign_caps (workspace_id TEXT NOT NULL,campaign_version_id TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN('call','email','linkedin')),
        ${integer('revision', 1)},${integer('reserved')},${integer('sent')},PRIMARY KEY(workspace_id,campaign_version_id,channel),
        FOREIGN KEY(workspace_id,campaign_version_id) REFERENCES campaign_versions(workspace_id,id))`,
      `CREATE TABLE campaign_command_receipts (workspace_id TEXT NOT NULL,command_id TEXT NOT NULL,${hash('fingerprint')},
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL,PRIMARY KEY(workspace_id,command_id))`,
      `CREATE TABLE manual_linkedin_drafts (workspace_id TEXT NOT NULL,id TEXT NOT NULL,account_id TEXT NOT NULL,enrollment_id TEXT NOT NULL,campaign_version_id TEXT NOT NULL,
        person_id TEXT REFERENCES persons(id),step_id TEXT NOT NULL,route_id TEXT NOT NULL,${integer('route_version', 1)},${integer('context_revision')},execution_context_id TEXT NOT NULL,
        ${integer('revision', 1)},body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 24000),${hash('content_hash')},${hash('target_hash')},
        state TEXT NOT NULL CHECK(state IN('draft','approved','held','closed')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,id),
        FOREIGN KEY(workspace_id,account_id,enrollment_id) REFERENCES campaign_enrollments(workspace_id,account_id,id),
        FOREIGN KEY(workspace_id,campaign_version_id) REFERENCES campaign_versions(workspace_id,id),
        FOREIGN KEY(account_id,route_id,route_version) REFERENCES pm_account_routes(account_id,id,version))`,
      `CREATE TABLE manual_linkedin_draft_approvals (workspace_id TEXT NOT NULL,draft_id TEXT NOT NULL,${integer('draft_revision', 1)},${hash('content_hash')},${hash('target_hash')},
        ${integer('context_revision')},execution_context_id TEXT NOT NULL,approved_at TEXT NOT NULL,command_id TEXT NOT NULL,PRIMARY KEY(workspace_id,draft_id,draft_revision),UNIQUE(workspace_id,command_id),
        FOREIGN KEY(workspace_id,draft_id) REFERENCES manual_linkedin_drafts(workspace_id,id))`,
      `CREATE TABLE delegated_transport_state (workspace_id TEXT NOT NULL,pairing_id TEXT NOT NULL,${integer('revision', 1)},cursor TEXT,completed_at TEXT,
        attempt_id TEXT NOT NULL,started_at TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','complete','failed')),PRIMARY KEY(workspace_id,pairing_id),
        CHECK((state='complete' AND completed_at IS NOT NULL) OR (state<>'complete' AND completed_at IS NULL)))`,
      `CREATE TABLE delegated_manual_handoffs (workspace_id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES pm_accounts(id),handoff_id TEXT NOT NULL,action_id TEXT NOT NULL,
        ${integer('authority_generation')},${hash('target_hash')},${hash('content_hash')},context_revision TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN('call','linkedin')),
        route_id TEXT NOT NULL,${integer('route_version', 1)},expires_at TEXT NOT NULL,event_id TEXT NOT NULL,consumed_at TEXT,outcome_command_id TEXT,
        PRIMARY KEY(workspace_id,handoff_id),UNIQUE(workspace_id,action_id),FOREIGN KEY(account_id,route_id,route_version) REFERENCES pm_account_routes(account_id,id,version))`,
      `CREATE TABLE delegated_local_configuration (workspace_id TEXT NOT NULL,pairing_id TEXT NOT NULL,${integer('revision', 1)},
        configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)),updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,pairing_id))`,
      `CREATE TABLE workspace_workflow_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),mode TEXT NOT NULL CHECK(mode IN('legacy','meeting_first')),${integer('revision', 1)},updated_at TEXT NOT NULL)`,
      `CREATE TABLE workflow_transition_receipts (command_id TEXT PRIMARY KEY,manifest_id TEXT NOT NULL UNIQUE,${hash('fingerprint')},result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL)`,
      ...['workflow_transition_receipts', 'campaign_versions', 'campaign_approvals', 'campaign_step_receipts', 'campaign_command_receipts', 'manual_linkedin_draft_approvals'].flatMap(table => ['UPDATE', 'DELETE'].map(operation =>
        `CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Campaign evidence is immutable'); END`)),
    ];
    for (const statement of statements) await sql.raw(statement).execute(db);
    await sql`UPDATE app_meta SET schema_version=23,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};
