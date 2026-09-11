import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';

/** Additive only: never reinterpret historical people, owners, catalogs or sends. */
export const migration0020PmAccounts = {
  async up(db: Kysely<FoundationDatabase>) {
    const statements = [
      `CREATE TABLE pm_accounts (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 300), domain TEXT,
        version INTEGER NOT NULL CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE pm_account_commands (command_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64), result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        account_version INTEGER NOT NULL CHECK(account_version>0), created_at TEXT NOT NULL, UNIQUE(account_id,command_id))`,
      `CREATE UNIQUE INDEX pm_account_command_once ON pm_account_commands(command_id)`,
      `CREATE TABLE pm_account_sources (id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        source_key TEXT NOT NULL, url TEXT NOT NULL CHECK(length(url)<=2048), fetched_at TEXT NOT NULL,
        sha256 TEXT NOT NULL CHECK(length(sha256)=64), excerpt TEXT NOT NULL CHECK(length(excerpt) BETWEEN 1 AND 12000),
        permitted INTEGER NOT NULL CHECK(permitted=1), admitted_at TEXT NOT NULL, UNIQUE(account_id,id))`,
      `CREATE UNIQUE INDEX pm_account_source_receipt_once ON pm_account_sources(account_id, source_key)`,
      `CREATE TABLE pm_account_claims (id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        claim_json TEXT NOT NULL CHECK(json_valid(claim_json)), admitted_at TEXT NOT NULL, UNIQUE(account_id,id))`,
      `CREATE TABLE pm_account_claim_evidence (account_id TEXT NOT NULL, claim_id TEXT NOT NULL, source_id TEXT NOT NULL,
        PRIMARY KEY(account_id,claim_id,source_id), FOREIGN KEY(account_id,claim_id) REFERENCES pm_account_claims(account_id,id),
        FOREIGN KEY(account_id,source_id) REFERENCES pm_account_sources(account_id,id))`,
      `CREATE TABLE pm_account_routes (id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        version INTEGER NOT NULL CHECK(version>0), person_id TEXT REFERENCES persons(id), channel TEXT NOT NULL CHECK(channel IN ('phone','email','linkedin')),
        value TEXT NOT NULL CHECK(length(value) BETWEEN 1 AND 2048), purpose TEXT NOT NULL CHECK(purpose IN ('business','tenant_emergency','unknown')),
        verification TEXT NOT NULL CHECK(verification IN ('published','confirmed','unverified')), admitted_at TEXT NOT NULL,
        PRIMARY KEY(id,version), UNIQUE(account_id,id,version))`,
      `CREATE TABLE pm_account_route_evidence (account_id TEXT NOT NULL, route_id TEXT NOT NULL, route_version INTEGER NOT NULL, source_id TEXT NOT NULL,
        PRIMARY KEY(account_id,route_id,route_version,source_id), FOREIGN KEY(account_id,route_id,route_version) REFERENCES pm_account_routes(account_id,id,version),
        FOREIGN KEY(account_id,source_id) REFERENCES pm_account_sources(account_id,id))`,
      `CREATE TABLE pm_account_links (id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        kind TEXT NOT NULL CHECK(kind IN ('organization','person_role','property')), organization_id TEXT REFERENCES organizations(id),
        person_id TEXT REFERENCES persons(id), property_id TEXT REFERENCES properties(id), relationship TEXT NOT NULL CHECK(length(relationship) BETWEEN 1 AND 200),
        role TEXT, authority TEXT CHECK(authority IN ('unconfirmed','confirmed')), valid_from TEXT NOT NULL, valid_to TEXT,
        admitted_at TEXT NOT NULL, CHECK(valid_to IS NULL OR valid_to>valid_from), UNIQUE(account_id,id),
        CHECK((kind='organization' AND organization_id IS NOT NULL AND person_id IS NULL AND property_id IS NULL AND role IS NULL AND authority IS NULL)
          OR (kind='property' AND property_id IS NOT NULL AND person_id IS NULL AND organization_id IS NULL AND role IS NULL AND authority IS NULL)
          OR (kind='person_role' AND person_id IS NOT NULL AND organization_id IS NULL AND property_id IS NULL AND role IS NOT NULL AND authority IS NOT NULL)))`,
      `CREATE TABLE pm_account_link_evidence (account_id TEXT NOT NULL, link_id TEXT NOT NULL, source_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('relationship','authority')), PRIMARY KEY(account_id,link_id,source_id,purpose),
        FOREIGN KEY(account_id,link_id) REFERENCES pm_account_links(account_id,id), FOREIGN KEY(account_id,source_id) REFERENCES pm_account_sources(account_id,id))`,
      `CREATE TABLE pm_account_research_jobs (id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        command_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64), limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),
        state TEXT NOT NULL CHECK(state IN ('queued','running','completed','parked')), attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3),
        claim_token TEXT UNIQUE, reserved_cost_micros INTEGER NOT NULL CHECK(reserved_cost_micros>=0), cost_micros INTEGER CHECK(cost_micros>=0),
        receipt_command_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id,receipt_command_id) REFERENCES pm_account_commands(account_id,command_id),
        CHECK(state<>'running' OR claim_token IS NOT NULL))`,
      `CREATE TABLE pm_account_outbound_intents (command_id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        route_id TEXT NOT NULL, route_version INTEGER NOT NULL, account_version INTEGER NOT NULL CHECK(account_version>0),
        evidence_fingerprint TEXT NOT NULL CHECK(length(evidence_fingerprint)=64), command_fingerprint TEXT NOT NULL CHECK(length(command_fingerprint)=64),
        attempt_id TEXT NOT NULL UNIQUE, channel TEXT NOT NULL CHECK(channel IN ('call','email')), canonical_target TEXT NOT NULL CHECK(length(canonical_target) BETWEEN 1 AND 2048),
        context_revision TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(command_id,attempt_id,account_id),
        FOREIGN KEY(account_id,route_id,route_version) REFERENCES pm_account_routes(account_id,id,version))`,
      `CREATE TABLE pm_account_outbound_results (id TEXT PRIMARY KEY NOT NULL, command_id TEXT NOT NULL, attempt_id TEXT NOT NULL, account_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('dispatch','call_outcome','reconciliation')), outcome TEXT NOT NULL CHECK(length(outcome) BETWEEN 1 AND 100),
        result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json)<=24000), created_at TEXT NOT NULL,
        FOREIGN KEY(command_id,attempt_id,account_id) REFERENCES pm_account_outbound_intents(command_id,attempt_id,account_id))`,
      ...['commands','sources','claims','claim_evidence','routes','route_evidence','links','link_evidence','outbound_intents','outbound_results'].flatMap(name => ['UPDATE','DELETE'].map(operation =>
        `CREATE TRIGGER pm_account_${name}_no_${operation.toLowerCase()} BEFORE ${operation} ON pm_account_${name}
         BEGIN SELECT RAISE(ABORT, 'PM account evidence is immutable'); END`)),
    ];
    for (const statement of statements) await sql.raw(statement).execute(db);
    await sql`UPDATE app_meta SET schema_version=20,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};
