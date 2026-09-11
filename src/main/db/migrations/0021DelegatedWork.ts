import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';

/** Additive storage only. Research and historical sends never acquire authority. */
export const migration0021DelegatedWork = {
  async up(db: Kysely<FoundationDatabase>) {
    const statements = [
      `CREATE TABLE meeting_first_call_settings (singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
        new_call_slots INTEGER CHECK(new_call_slots BETWEEN 0 AND 9007199254740991),
        total_call_capacity INTEGER CHECK(total_call_capacity BETWEEN 0 AND 9007199254740991),
        revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991), updated_at TEXT NOT NULL)`,
      `CREATE TABLE delegated_authorities (account_id TEXT PRIMARY KEY NOT NULL REFERENCES pm_accounts(id), workspace_id TEXT NOT NULL,
        owner TEXT NOT NULL CHECK(owner IN ('local','worker')), generation INTEGER NOT NULL CHECK(generation>=0),
        state TEXT NOT NULL CHECK(state IN ('local','delegating','active','paused','revoked')), aggregate_version INTEGER NOT NULL CHECK(aggregate_version>=0),
        updated_at TEXT NOT NULL, CHECK(state<>'local' OR owner='local'))`,
      `CREATE TABLE delegated_commands (command_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64), command_json TEXT NOT NULL CHECK(json_valid(command_json)),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at TEXT NOT NULL, UNIQUE(workspace_id,account_id,command_id))`,
      `CREATE TABLE delegated_applied_events (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        stream TEXT NOT NULL CHECK(stream IN ('execution','research')), aggregate_version INTEGER NOT NULL CHECK(aggregate_version>0),
        authority_generation INTEGER NOT NULL CHECK(authority_generation>=0), fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
        event_json TEXT NOT NULL CHECK(json_valid(event_json)), applied_at TEXT NOT NULL, UNIQUE(workspace_id,account_id,stream,aggregate_version))`,
      `CREATE TABLE delegated_event_cursors (workspace_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        stream TEXT NOT NULL CHECK(stream IN ('execution','research')), aggregate_version INTEGER NOT NULL CHECK(aggregate_version>0),
        event_id TEXT NOT NULL REFERENCES delegated_applied_events(id), PRIMARY KEY(workspace_id,account_id,stream))`,
      `CREATE TABLE delegated_approvals (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        route_id TEXT NOT NULL, route_version INTEGER NOT NULL, permission_evidence_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64), snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), approved_at TEXT NOT NULL,
        FOREIGN KEY(account_id,route_id,route_version) REFERENCES pm_account_routes(account_id,id,version),
        FOREIGN KEY(account_id,permission_evidence_id) REFERENCES pm_account_sources(account_id,id))`,
      `CREATE TABLE delegated_action_outcomes (event_id TEXT PRIMARY KEY NOT NULL REFERENCES delegated_applied_events(id),
        workspace_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id), action_id TEXT NOT NULL,
        authority_generation INTEGER NOT NULL CHECK(authority_generation>=0), state TEXT NOT NULL CHECK(state IN ('prepared','queued','dispatching','unknown','human_reported_sent','provider_accepted','cancelled')),
        content_hash TEXT NOT NULL CHECK(length(content_hash)=64), target_hash TEXT NOT NULL CHECK(length(target_hash)=64),
        observed_at TEXT NOT NULL, evidence_ref TEXT NOT NULL)`,
      `CREATE TABLE delegated_manual_outcomes (event_id TEXT PRIMARY KEY NOT NULL REFERENCES delegated_applied_events(id),
        workspace_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id), action_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('call','linkedin')), outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)), observed_at TEXT NOT NULL)`,
      `CREATE TABLE delegated_threads (workspace_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id), id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider='gmail'), provider_thread_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
        context_revision TEXT NOT NULL, projection_json TEXT NOT NULL CHECK(json_valid(projection_json)), updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id,account_id,id), UNIQUE(workspace_id,provider,provider_thread_id))`,
      `CREATE TABLE delegated_meetings (workspace_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id), id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider='google_calendar'), provider_event_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
        state TEXT NOT NULL CHECK(state IN ('prepared','dispatching','unknown','created','cancelled','held')),
        projection_json TEXT NOT NULL CHECK(json_valid(projection_json)), updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id,account_id,id), UNIQUE(workspace_id,provider,provider_event_id))`,
      `CREATE TABLE delegated_reconciliation (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        action_id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES delegated_applied_events(id), evidence_ref TEXT NOT NULL,
        observed_at TEXT NOT NULL, UNIQUE(workspace_id,account_id,action_id,event_id))`,
      `CREATE UNIQUE INDEX pm_account_route_policy_target ON pm_account_routes(account_id,id,version,value)`,
      `CREATE TABLE pm_account_route_policy_receipts (id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, route_id TEXT NOT NULL,
        route_version INTEGER NOT NULL, canonical_target TEXT NOT NULL, evidence_fingerprint TEXT NOT NULL CHECK(length(evidence_fingerprint)=64),
        revision INTEGER NOT NULL CHECK(revision>0), evidence_ref TEXT NOT NULL, provenance TEXT NOT NULL,
        observed_at TEXT NOT NULL, admitted_at TEXT NOT NULL, effective_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), receipt_fingerprint TEXT NOT NULL CHECK(length(receipt_fingerprint)=64), UNIQUE(account_id,route_id,route_version,revision),
        UNIQUE(account_id,route_id,route_version,id),
        FOREIGN KEY(account_id,route_id,route_version,canonical_target) REFERENCES pm_account_routes(account_id,id,version,value),
        FOREIGN KEY(account_id,evidence_ref) REFERENCES pm_account_sources(account_id,id),
        CHECK(observed_at<=admitted_at AND effective_at<=admitted_at AND (expires_at IS NULL OR expires_at>effective_at)))`,
      `CREATE TABLE pm_account_route_policy_evidence (account_id TEXT NOT NULL, route_id TEXT NOT NULL, route_version INTEGER NOT NULL,
        receipt_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(receipt_id,source_id),
        FOREIGN KEY(account_id,route_id,route_version,receipt_id) REFERENCES pm_account_route_policy_receipts(account_id,route_id,route_version,id),
        FOREIGN KEY(account_id,route_id,route_version,source_id) REFERENCES pm_account_route_evidence(account_id,route_id,route_version,source_id))`,
      `CREATE TABLE pm_account_suppression_tombstones (id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        observed_at TEXT NOT NULL, source TEXT NOT NULL, evidence_ref TEXT NOT NULL, admitted_at TEXT NOT NULL)`,
      `CREATE TABLE pm_handle_suppression_tombstones (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('phone','email')),
        normalized_value TEXT NOT NULL CHECK(length(normalized_value)>0 AND normalized_value=lower(trim(normalized_value))),
        observed_at TEXT NOT NULL, source TEXT NOT NULL, evidence_ref TEXT NOT NULL, admitted_at TEXT NOT NULL)`,
      `CREATE TABLE discovery_approved_budgets (workspace_id TEXT NOT NULL, budget_id TEXT NOT NULL,
        ceiling_micros INTEGER NOT NULL CHECK(ceiling_micros BETWEEN 0 AND 9007199254740991), approved_at TEXT NOT NULL, evidence_ref TEXT NOT NULL,
        PRIMARY KEY(workspace_id,budget_id))`,
      `CREATE TABLE discovery_reservations (workspace_id TEXT NOT NULL, budget_id TEXT NOT NULL, command_id TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint)=64), search_cost_micros INTEGER NOT NULL CHECK(search_cost_micros BETWEEN 0 AND 9007199254740991),
        model_cost_micros INTEGER NOT NULL CHECK(model_cost_micros BETWEEN 0 AND 9007199254740991), reserved_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id,budget_id,command_id), FOREIGN KEY(workspace_id,budget_id) REFERENCES discovery_approved_budgets(workspace_id,budget_id),
        CHECK(search_cost_micros+model_cost_micros<=9007199254740991))`,
      `CREATE TABLE discovery_receipts (workspace_id TEXT NOT NULL, budget_id TEXT NOT NULL, command_id TEXT NOT NULL,
        candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json)), cost_micros INTEGER CHECK(cost_micros BETWEEN 0 AND 9007199254740991),
        completed_at TEXT NOT NULL, PRIMARY KEY(workspace_id,budget_id,command_id),
        FOREIGN KEY(workspace_id,budget_id,command_id) REFERENCES discovery_reservations(workspace_id,budget_id,command_id))`,
      `CREATE INDEX pm_account_suppression_lookup ON pm_account_suppression_tombstones(account_id)`,
      `CREATE INDEX pm_handle_suppression_lookup ON pm_handle_suppression_tombstones(kind,normalized_value)`,
      `CREATE TRIGGER discovery_reservations_budget_guard BEFORE INSERT ON discovery_reservations
        WHEN NEW.search_cost_micros+NEW.model_cost_micros > (SELECT ceiling_micros FROM discovery_approved_budgets WHERE workspace_id=NEW.workspace_id AND budget_id=NEW.budget_id)
          - (SELECT COALESCE(SUM(COALESCE(c.cost_micros,r.search_cost_micros+r.model_cost_micros)),0)
             FROM discovery_reservations r LEFT JOIN discovery_receipts c USING(workspace_id,budget_id,command_id)
             WHERE r.workspace_id=NEW.workspace_id AND r.budget_id=NEW.budget_id)
        BEGIN SELECT RAISE(ABORT, 'Discovery budget exhausted'); END`,
      `CREATE TRIGGER discovery_receipts_ceiling_guard BEFORE INSERT ON discovery_receipts
        WHEN NEW.cost_micros > (SELECT search_cost_micros+model_cost_micros FROM discovery_reservations
          WHERE workspace_id=NEW.workspace_id AND budget_id=NEW.budget_id AND command_id=NEW.command_id)
        BEGIN SELECT RAISE(ABORT, 'Discovery receipt exceeds reserved ceiling'); END`,
      `CREATE UNIQUE INDEX delegated_receipt_once ON delegated_applied_events(workspace_id,json_extract(event_json,'$.payload.receipt.commandId'))
        WHERE json_extract(event_json,'$.kind')='authority.changed'`,
      ...['delegated_manual_outcomes' ,'delegated_commands','delegated_applied_events','delegated_approvals','delegated_action_outcomes','delegated_reconciliation',
        'pm_account_route_policy_receipts','pm_account_route_policy_evidence','pm_account_suppression_tombstones','pm_handle_suppression_tombstones',
        'discovery_approved_budgets','discovery_reservations','discovery_receipts'].flatMap(table => ['UPDATE','DELETE'].map(operation =>
        `CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Delegation evidence is immutable'); END`)),
    ];
    for (const statement of statements) await sql.raw(statement).execute(db);
    await sql`INSERT INTO meeting_first_call_settings VALUES(1,NULL,NULL,0,${new Date().toISOString()})`.execute(db);
    await sql`UPDATE app_meta SET schema_version=21,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};
